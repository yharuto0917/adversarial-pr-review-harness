import { DurableObject } from "cloudflare:workers";
import type { MutableModels } from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
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
  /** `<provider>/<model id>` 形式。 */
  readonly REVIEW_MODEL?: string;
  readonly GEMINI_API_KEY?: string;
  readonly ANTHROPIC_API_KEY?: string;
}

export interface ReviewRequest {
  /** webhook の delivery id。同じ id の再送は同じレビュー実行として扱う。 */
  readonly deliveryId: string;
  /** `owner/name` 形式。 */
  readonly repository: string;
  readonly pullNumber: number;
  readonly headSha: string;
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

  /** レビューを開始する。モデルが動く前に、入力を永続化した時点で返る。 */
  async start(request: ReviewRequest): Promise<PiReceipt> {
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
      github: unimplementedGitHub,
      findings: {
        report: async (finding) => {
          this.#findings.record(await this.#runningOperation(), finding);
        },
      },
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

/** TODO: @repo/github の実装後に、installation token を使う実体へ置き換える。 */
const unimplementedGitHub: GitHubPort = {
  getDiff: () => Promise.reject(new Error("not implemented: GitHubPort.getDiff")),
  postReview: () => Promise.reject(new Error("not implemented: GitHubPort.postReview")),
  resolveThread: () => Promise.reject(new Error("not implemented: GitHubPort.resolveThread")),
};
