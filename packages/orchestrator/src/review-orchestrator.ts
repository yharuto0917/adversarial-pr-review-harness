import { DurableObject } from "cloudflare:workers";
import type { MutableModels } from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { createPullRequestClient, issueInstallationToken } from "@repo/github";
import {
  bindSandbox,
  createReviewExtension,
  createReviewModels,
  type GitHubPort,
  type HarnessPorts,
  parseModelRef,
  type SandboxService,
} from "@repo/harness";
import { PiHarness, type PiOperationResult, type PiReceipt } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";

import { type CredentialVault, VAULT_INSTANCE_NAME } from "./credential-vault.js";
import { type RecordedFinding, SqlFindingsStore } from "./findings-store.js";
import { vaultCredentials } from "./vault-credentials.js";

/** `REVIEW_MODEL` が未設定のときに使うモデル。 */
export const DEFAULT_REVIEW_MODEL = "openai/gpt-6-sol";

export interface OrchestratorEnv {
  readonly VAULT: DurableObjectNamespace<CredentialVault>;
  readonly RUNNER: SandboxService;
  readonly GITHUB_APP_ID: string;
  readonly GITHUB_APP_PRIVATE_KEY: string;
  /** `<provider>/<model id>` 形式。 */
  readonly REVIEW_MODEL?: string;
  readonly GEMINI_API_KEY?: string;
  readonly ANTHROPIC_API_KEY?: string;
  readonly OPENCODE_API_KEY?: string;
  readonly OPENROUTER_API_KEY?: string;
}

export interface ReviewRequest {
  /** webhook の delivery id。同じ id の再送は同じレビュー実行として扱う。 */
  readonly deliveryId: string;
  /** `owner/name` 形式。 */
  readonly repository: string;
  readonly pullNumber: number;
  readonly headSha: string;
  /** GitHub App の installation id。 */
  readonly installationId?: number;
}

interface ReviewTarget {
  readonly repository: string;
  readonly pullNumber: number;
  readonly headSha: string;
  readonly installationId: number;
}

/**
 * PR 単位のレビューを担う Durable Object。
 *
 * エージェントループ・トランスクリプト・中断からの復帰は Pi (PiHarness) に任せ、
 * ここはモデル・ツール・認証の配線と、レビュー実行の受け付けだけを持つ。
 * アラームは Lifecycle が所有するので、このクラスで alarm() を定義してはいけない。
 */
export class ReviewOrchestrator extends DurableObject<OrchestratorEnv> {
  readonly #findings = new SqlFindingsStore(this.ctx.storage.sql);
  readonly #registry = createRegistry();

  readonly harness = new PiHarness({
    harness: ({ storage, context }) => {
      this.#registry.install(createReviewExtension(this.ports()));
      return Harness.open(
        storage,
        { models: this.createModels(), registry: this.#registry },
        context,
      );
    },
    defaults: { model: parseModelRef(this.env.REVIEW_MODEL ?? DEFAULT_REVIEW_MODEL) },
  });

  readonly lifecycle = Lifecycle.install(this).use(this.harness);

  constructor(ctx: DurableObjectState, env: OrchestratorEnv) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS review_target (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      repository TEXT NOT NULL,
      pull_number INTEGER NOT NULL,
      head_sha TEXT NOT NULL,
      installation_id INTEGER NOT NULL
    )`);
  }

  /** レビューを開始する。モデルが動く前に、入力を永続化した時点で返る。 */
  async start(request: ReviewRequest): Promise<PiReceipt> {
    this.#saveTarget(request);
    // TODO: サンドボックスに PR の head をチェックアウトする（installation token が要る）
    return this.harness.submit(
      `${request.repository} の Pull Request #${request.pullNumber}（head: ${request.headSha}）をレビューしてください。`,
      { operationId: request.deliveryId },
    );
  }

  /** レビュー実行の完了を待ち、結果を返す。 */
  async result(deliveryId: string): Promise<PiOperationResult> {
    return this.harness.wait(deliveryId);
  }

  /** あるレビュー実行で報告された指摘を返す。 */
  async findings(deliveryId: string): Promise<RecordedFinding[]> {
    return this.#findings.list(deliveryId);
  }

  /** テストで擬似モデルに差し替えるための継ぎ目。 */
  protected createModels(): MutableModels {
    const env = this.env as unknown as Record<string, string | undefined>;
    return createReviewModels({
      credentials: vaultCredentials(this.env.VAULT.getByName(VAULT_INSTANCE_NAME)),
      env: (name) => env[name],
    });
  }

  /** テストで外部依存を差し替えるための継ぎ目。 */
  protected ports(): HarnessPorts {
    return {
      sandbox: bindSandbox(this.env.RUNNER, this.ctx.id.toString()),
      github: this.#createGitHubPort(),
      findings: {
        report: async (finding) => {
          this.#findings.record(await this.#runningOperation(), finding);
        },
      },
    };
  }

  /**
   * PR ごとの DO が都度 installation token を発行して GitHub API を呼ぶ。
   * トークンは DO 内部に閉じ込め、ツール側には渡さない。
   */
  #createGitHubPort(): GitHubPort {
    const client = () => {
      const target = this.#requireTarget();
      return createPullRequestClient({
        repository: target.repository,
        pullNumber: target.pullNumber,
        getToken: () =>
          issueInstallationToken({
            appId: this.env.GITHUB_APP_ID,
            privateKey: this.env.GITHUB_APP_PRIVATE_KEY,
            installationId: target.installationId,
          }),
      });
    };
    return {
      getDiff: () => client().getDiff(),
      postReview: (body) => client().postReview(body),
      resolveThread: (threadId) => client().resolveThread(threadId),
    };
  }

  #saveTarget(request: ReviewRequest): void {
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO review_target (id, repository, pull_number, head_sha, installation_id)
       VALUES (1, ?, ?, ?, ?)`,
      request.repository,
      request.pullNumber,
      request.headSha,
      request.installationId ?? 0,
    );
  }

  #requireTarget(): ReviewTarget {
    const row = this.ctx.storage.sql
      .exec<{
        repository: string;
        pull_number: number;
        head_sha: string;
        installation_id: number;
      }>(
        "SELECT repository, pull_number, head_sha, installation_id FROM review_target WHERE id = 1",
      )
      .toArray()[0];
    if (!row) {
      throw new Error("review target is not initialized; call start() first");
    }
    return {
      repository: row.repository,
      pullNumber: row.pull_number,
      headSha: row.head_sha,
      installationId: row.installation_id,
    };
  }

  /** いま実行中のレビュー。ツールは実行中のレビューからしか呼ばれない。 */
  async #runningOperation(): Promise<string> {
    const running = (await this.harness.pending()).find((op) => op.status === "running");
    if (!running) {
      throw new Error("a finding was reported while no review is running");
    }
    return running.operationId;
  }
}
