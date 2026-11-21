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
  type SandboxPort,
  type SandboxService,
  setupNodeProject,
} from "@repo/harness";
import { PiHarness, type PiOperationResult, type PiReceipt } from "agents/harness/pi";
import { Lifecycle, type LifecycleJobContext, type LifecycleJobOutcome } from "agents/lifecycle";

import { type CredentialVault, VAULT_INSTANCE_NAME } from "./credential-vault.js";
import { type RecordedFinding, SqlFindingsStore } from "./findings-store.js";
import { vaultCredentials } from "./vault-credentials.js";

/** `REVIEW_MODEL` が未設定のときに使うモデル。 */
export const DEFAULT_REVIEW_MODEL = "openai/gpt-6-sol";

/** サンドボックスの最大生存時間（既定 30 分）。異常終了やハングでもこの時間で強制破棄する。 */
export const DEFAULT_SANDBOX_MAX_LIFETIME_MS = 30 * 60 * 1_000;

/** DO 退避などで完了監視が失われた場合にアイドル破棄を救済するポーリング間隔（既定 60 秒）。 */
export const DEFAULT_SANDBOX_CLEANUP_POLL_MS = 60 * 1_000;

const SANDBOX_CLEANUP_JOB_ID = "sandbox-cleanup";
const SANDBOX_CLEANUP_JOB_FN = "cleanupSandbox";
const SANDBOX_CLEANUP_HUNG_TIMEOUT_SECONDS = 120;
const DEFAULT_DESTROY_RETRY_BASE_DELAY_MS = 30_000;
const DESTROY_MAX_RETRIES = 5;
const ABORT_WAIT_TIMEOUT_MS = 10_000;

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
  readonly checkedOutSha: string | null;
  readonly testCommands: readonly string[];
  readonly sandboxActive: boolean;
  readonly sandboxGeneration: number;
  readonly sandboxExpiresAt: number | null;
}

interface CleanupJobPayload {
  readonly generation: number;
  readonly pendingDestroy?: boolean;
  readonly retryCount?: number;
}

type SandboxDestroyReason =
  | "review_completed"
  | "setup_failed"
  | "ttl_expired"
  | "idle_after_recovery";

interface InflightSetup {
  readonly key: string;
  readonly promise: Promise<readonly string[]>;
}

const SAFE_REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

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
  readonly #inflightStarts = new Map<string, Promise<PiReceipt>>();
  #admittingStarts = 0;
  #inflightSetup: InflightSetup | null = null;
  #inflightIdleCheck: Promise<void> | null = null;
  #inflightCleanup: Promise<void> | null = null;

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
    this.#ensureSchema();
  }

  /** レビューを開始する。モデルが動く前に、入力を永続化した時点で返る。 */
  async start(request: ReviewRequest): Promise<PiReceipt> {
    if (!SAFE_REPOSITORY.test(request.repository) || request.repository.includes("..")) {
      throw new Error(`invalid repository: ${request.repository}`);
    }
    if (!SAFE_REF.test(request.headSha) || request.headSha.includes("..")) {
      throw new Error(`invalid headSha: ${request.headSha}`);
    }
    this.#ensureSchema();

    // すでに受理済みの deliveryId の再送では、サンドボックスを再起動せずに重複結果を返す
    if (this.#hasDelivery(request.deliveryId)) {
      return this.harness.submit("", { operationId: request.deliveryId });
    }

    // 同じ deliveryId がセットアップ中に並行到着した場合は先行処理の完了を待ってから判定する
    while (true) {
      const existingInflight = this.#inflightStarts.get(request.deliveryId);
      if (!existingInflight) {
        break;
      }
      try {
        await existingInflight;
      } catch {
        // 先行するセットアップ失敗時は後続リクエストで再試行する
      }
      if (this.#hasDelivery(request.deliveryId)) {
        return this.harness.submit("", { operationId: request.deliveryId });
      }
    }

    this.#admittingStarts += 1;
    const startPromise = (async (): Promise<PiReceipt> => {
      let setupFailed = false;
      try {
        let testCommands: readonly string[];
        try {
          testCommands = await this.#prepareTarget(request);
        } catch (error) {
          setupFailed = true;
          throw error;
        }
        const receipt = await this.harness.submit(buildReviewPrompt(request, testCommands), {
          operationId: request.deliveryId,
        });
        this.#recordDelivery(request.deliveryId);
        if (receipt.accepted) {
          this.#watchOperationCompletion(receipt.operationId);
        } else {
          this.ctx.waitUntil(this.#cleanupSandboxIfIdle());
        }
        return receipt;
      } finally {
        this.#admittingStarts -= 1;
        // 共有 #inflightSetup を含め全ての並行 start() が受付を終えた時点で、
        // 他に進行中レビューが無ければ失敗したセットアップのコンテナを即座に破棄する
        if (setupFailed && this.#admittingStarts === 0 && this.#inflightSetup === null) {
          const pending = await this.harness.pending().catch(() => null);
          if (pending !== null && pending.length === 0 && this.#admittingStarts === 0) {
            await this.#destroySandbox("setup_failed", { swallowErrors: true });
          }
        }
      }
    })();

    this.#inflightStarts.set(request.deliveryId, startPromise);
    const clearInflightStart = () => {
      if (this.#inflightStarts.get(request.deliveryId) === startPromise) {
        this.#inflightStarts.delete(request.deliveryId);
      }
    };
    startPromise.then(clearInflightStart, clearInflightStart);
    return startPromise;
  }

  /** レビュー実行の完了を待ち、後片付けを反映したうえで結果を返す。 */
  async result(deliveryId: string): Promise<PiOperationResult> {
    const outcome = await this.harness.wait(deliveryId);
    await this.#cleanupSandboxIfIdle();
    return outcome;
  }

  /** あるレビュー実行で報告された指摘を返す。 */
  async findings(deliveryId: string): Promise<RecordedFinding[]> {
    return this.#findings.list(deliveryId);
  }

  /**
   * Lifecycle が管理するホストジョブのディスパッチ入口。
   * サンドボックスの最大生存時間（TTL）超過による強制破棄、DO 退避後のアイドル回収、
   * および破棄 RPC 一時失敗時の指数バックオフ再試行を担う。
   */
  async onJob(context: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    if (context.job.fn !== SANDBOX_CLEANUP_JOB_FN) {
      return;
    }
    try {
      this.#ensureSchema();
      const payload = parseCleanupJobPayload(context.job.payload);
      const target = this.#getTarget();
      if (!target) {
        return;
      }

      if (payload !== null && target.sandboxGeneration !== payload.generation) {
        return;
      }

      if (payload?.pendingDestroy) {
        await this.#retryPendingDestroy(payload.generation, payload.retryCount ?? 0);
        return;
      }

      if (!target.sandboxActive) {
        return;
      }

      const now = Date.now();
      if (target.sandboxExpiresAt !== null && now >= target.sandboxExpiresAt) {
        await this.#destroySandbox("ttl_expired", {
          expectedGeneration: target.sandboxGeneration,
          forceAbort: true,
          swallowErrors: true,
        });
        return;
      }

      if (this.#admittingStarts === 0 && this.#inflightSetup === null) {
        const pending = await this.harness.pending();
        if (pending.length === 0 && this.#admittingStarts === 0 && this.#inflightSetup === null) {
          await this.#destroySandbox("idle_after_recovery", {
            expectedGeneration: target.sandboxGeneration,
            swallowErrors: true,
          });
          return;
        }
      }

      const nextCheckAt =
        target.sandboxExpiresAt !== null
          ? Math.min(now + this.sandboxCleanupPollMs(), target.sandboxExpiresAt)
          : now + this.sandboxCleanupPollMs();
      return { rescheduleAt: nextCheckAt };
    } catch (error) {
      // Lifecycle のホスト onJob は未捕捉例外でジョブが消失するため、必ず捕捉して再スケジュールする
      console.error({
        event: "orchestrator.sandbox.cleanup_job_error",
        sandboxId: this.ctx.id.toString(),
        error: error instanceof Error ? error.message : String(error),
      });
      return { rescheduleAt: Date.now() + this.sandboxDestroyRetryBaseDelayMs() };
    }
  }

  /** テストでサンドボックス最大生存時間を差し替えるための継ぎ目。 */
  protected sandboxMaxLifetimeMs(): number {
    return DEFAULT_SANDBOX_MAX_LIFETIME_MS;
  }

  /** テストでアイドル回収ポーリング間隔を差し替えるための継ぎ目。 */
  protected sandboxCleanupPollMs(): number {
    return DEFAULT_SANDBOX_CLEANUP_POLL_MS;
  }

  /** テストで破棄失敗時のリトライ基準待機時間を差し替えるための継ぎ目。 */
  protected sandboxDestroyRetryBaseDelayMs(): number {
    return DEFAULT_DESTROY_RETRY_BASE_DELAY_MS;
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
    const rawSandbox = bindSandbox(this.env.RUNNER, this.ctx.id.toString());
    const assertSandboxUsable = () => {
      const target = this.#getTarget();
      if (!target?.sandboxActive) {
        throw new Error("sandbox is no longer active; it has already been destroyed");
      }
      if (target.sandboxExpiresAt !== null && Date.now() >= target.sandboxExpiresAt) {
        throw new Error("sandbox lifetime expired");
      }
    };
    const sandbox: SandboxPort = {
      exec: async (command, options) => {
        assertSandboxUsable();
        return rawSandbox.exec(command, options);
      },
      readFile: async (path) => {
        assertSandboxUsable();
        return rawSandbox.readFile(path);
      },
      writeFile: async (path, content) => {
        assertSandboxUsable();
        return rawSandbox.writeFile(path, content);
      },
      listFiles: async (path) => {
        assertSandboxUsable();
        return rawSandbox.listFiles(path);
      },
    };
    return {
      sandbox,
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
        getToken: () => this.#getInstallationToken(target.installationId),
      });
    };
    return {
      getDiff: () => client().getDiff(),
      postReview: (body) => client().postReview(body),
      resolveThread: (threadId) => client().resolveThread(threadId),
    };
  }

  #ensureSchema(): void {
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS review_target (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      repository TEXT NOT NULL,
      pull_number INTEGER NOT NULL,
      head_sha TEXT NOT NULL,
      installation_id INTEGER NOT NULL,
      checked_out_sha TEXT,
      test_commands_json TEXT NOT NULL DEFAULT '[]',
      sandbox_active INTEGER NOT NULL DEFAULT 0,
      sandbox_generation INTEGER NOT NULL DEFAULT 0,
      sandbox_expires_at INTEGER
    )`);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS review_deliveries (
      delivery_id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    )`);
    const columns = this.ctx.storage.sql
      .exec<{ name: string }>("PRAGMA table_info(review_target)")
      .toArray();
    if (!columns.some((col) => col.name === "test_commands_json")) {
      this.ctx.storage.sql.exec(
        "ALTER TABLE review_target ADD COLUMN test_commands_json TEXT NOT NULL DEFAULT '[]'",
      );
      this.ctx.storage.sql.exec("UPDATE review_target SET checked_out_sha = NULL WHERE id = 1");
    }
    if (!columns.some((col) => col.name === "sandbox_active")) {
      this.ctx.storage.sql.exec(
        "ALTER TABLE review_target ADD COLUMN sandbox_active INTEGER NOT NULL DEFAULT 0",
      );
    }
    if (!columns.some((col) => col.name === "sandbox_generation")) {
      this.ctx.storage.sql.exec(
        "ALTER TABLE review_target ADD COLUMN sandbox_generation INTEGER NOT NULL DEFAULT 0",
      );
    }
    if (!columns.some((col) => col.name === "sandbox_expires_at")) {
      this.ctx.storage.sql.exec("ALTER TABLE review_target ADD COLUMN sandbox_expires_at INTEGER");
    }
  }

  /**
   * サンドボックスのセットアップ（チェックアウトと依存インストール）を直列化する。
   * 同じ head のセットアップが進行中であれば、後続の git clean -fdx で node_modules を壊さないよう
   * 実行中の Promise を共有して待つ。
   */
  #prepareTarget(request: ReviewRequest): Promise<readonly string[]> {
    const key = `${request.repository}#${request.pullNumber}@${request.headSha}`;
    if (this.#inflightSetup?.key === key) {
      if (request.installationId !== undefined && request.installationId !== 0) {
        this.#saveTarget(request);
      }
      return this.#inflightSetup.promise;
    }

    const previous = this.#inflightSetup?.promise ?? Promise.resolve();
    let current!: InflightSetup;
    const run = async (): Promise<readonly string[]> => {
      try {
        try {
          await previous;
        } catch {
          // 先行する別 head のセットアップ失敗はそちらの呼び出し元に返っているため、後続のセットアップは続行する
        }
        this.#ensureSchema();
        this.#saveTarget(request);
        return await this.#checkoutHead();
      } finally {
        // 呼び出し元の catch/finally が走る前に #inflightSetup を確実にクリアする
        if (this.#inflightSetup === current) {
          this.#inflightSetup = null;
        }
      }
    };

    const promise = run();
    current = { key, promise };
    this.#inflightSetup = current;
    return promise;
  }

  /**
   * PR の head をサンドボックスのカレントディレクトリへチェックアウトし、
   * Node プロジェクトであればパッケージマネージャを検出して依存をインストールする。
   * アクティブな同一 head のサンドボックスが存在すれば再利用し、未作成・破棄済み・期限切れ・
   * head 更新時はコンテナを破棄して取り直す。
   * 最小権限（対象リポジトリ・contents: read）の installation token は runner の ContainerProxy
   * 側でオンメモリ注入し、コンテナ内のコマンド引数・環境変数・ファイルには一切渡さない。
   */
  async #checkoutHead(): Promise<readonly string[]> {
    // 進行中の後片付けが完了してからセットアップを開始し、破棄と作成の競合を防ぐ
    if (this.#inflightCleanup) {
      await this.#inflightCleanup;
    }

    this.#ensureSchema();
    const target = this.#requireTarget();
    const now = Date.now();
    if (
      target.sandboxActive &&
      target.checkedOutSha === target.headSha &&
      target.sandboxExpiresAt !== null &&
      now < target.sandboxExpiresAt
    ) {
      await this.#extendSandboxLifetime(target.sandboxGeneration);
      return target.testCommands;
    }

    const generation = target.sandboxGeneration + 1;
    const expiresAt = now + this.sandboxMaxLifetimeMs();
    this.ctx.storage.sql.exec(
      `UPDATE review_target
       SET checked_out_sha = NULL,
           test_commands_json = '[]',
           sandbox_active = 1,
           sandbox_generation = ?,
           sandbox_expires_at = ?
       WHERE id = 1`,
      generation,
      expiresAt,
    );
    await this.#scheduleCleanupJob(
      generation,
      Math.min(now + this.sandboxCleanupPollMs(), expiresAt),
    );

    const sandboxId = this.ctx.id.toString();
    const repoName = extractRepositoryName(target.repository);
    const token = await this.#getCheckoutToken(target.installationId, repoName);
    const basicAuth = btoa(`x-access-token:${token}`);
    const repoUrl = `https://github.com/${target.repository}.git`;
    const command = [
      "git init -q",
      `GIT_TERMINAL_PROMPT=0 git fetch --depth 1 ${repoUrl} -- ${target.headSha}`,
      "git checkout -q --force FETCH_HEAD",
      "git clean -fdx -q",
    ].join(" && ");

    const result = await this.env.RUNNER.exec(sandboxId, command, {
      egress: {
        profile: "checkout",
        repository: target.repository,
        githubToken: token,
        resetContainer: true,
      },
    });
    if (result.timedOut || result.exitCode !== 0) {
      const rawOutput = [result.stderr, result.stdout].filter(Boolean).join("\n");
      const detail = redactSecrets(rawOutput, [token, basicAuth]).trim();
      const verb = result.timedOut ? "timed out while checking out" : "failed to checkout";
      throw new Error(
        `${verb} ${target.repository}@${target.headSha} (exit ${result.exitCode})${detail ? `: ${detail}` : ""}`,
      );
    }

    const installSandbox = bindSandbox(this.env.RUNNER, sandboxId, {
      egress: { profile: "install" },
    });
    const project = await setupNodeProject(installSandbox);

    const latest = this.#getTarget();
    if (!latest?.sandboxActive || latest.sandboxGeneration !== generation) {
      throw new Error("sandbox was destroyed while preparing target");
    }

    this.ctx.storage.sql.exec(
      "UPDATE review_target SET checked_out_sha = ?, test_commands_json = ? WHERE id = 1 AND sandbox_generation = ?",
      target.headSha,
      JSON.stringify(project.testCommands),
      generation,
    );

    return project.testCommands;
  }

  #watchOperationCompletion(operationId: string): void {
    const work = (async () => {
      try {
        await this.harness.wait(operationId);
      } catch {
        // 待機中断時は永続クリーンアップジョブに委ねる
      }
      await this.#cleanupSandboxIfIdle();
    })();
    this.ctx.waitUntil(work);
  }

  async #cleanupSandboxIfIdle(): Promise<void> {
    if (this.#inflightIdleCheck) {
      return this.#inflightIdleCheck;
    }
    const run = async (): Promise<void> => {
      if (this.#inflightCleanup) {
        await this.#inflightCleanup;
      }
      const target = this.#getTarget();
      if (!target?.sandboxActive) {
        return;
      }
      // すでに現行世代の pendingDestroy バックオフ再試行が予約済みなら、上書き再実行せずジョブに委ねる
      const existingJob = this.lifecycle.jobs.get(SANDBOX_CLEANUP_JOB_ID);
      const existingPayload = parseCleanupJobPayload(existingJob?.payload);
      if (
        existingPayload?.pendingDestroy === true &&
        existingPayload.generation === target.sandboxGeneration
      ) {
        return;
      }
      if (this.#admittingStarts > 0 || this.#inflightSetup !== null) {
        return;
      }
      const pending = await this.harness.pending();
      if (pending.length > 0) {
        return;
      }
      if (this.#admittingStarts > 0 || this.#inflightSetup !== null) {
        return;
      }
      const latest = this.#getTarget();
      if (!latest?.sandboxActive || latest.sandboxGeneration !== target.sandboxGeneration) {
        if (this.#inflightCleanup) {
          await this.#inflightCleanup;
        }
        return;
      }
      await this.#destroySandbox("review_completed", {
        expectedGeneration: target.sandboxGeneration,
        swallowErrors: true,
      });
    };

    const check = run();
    this.#inflightIdleCheck = check;
    try {
      await check;
    } finally {
      if (this.#inflightIdleCheck === check) {
        this.#inflightIdleCheck = null;
      }
    }
  }

  async #extendSandboxLifetime(generation: number): Promise<void> {
    const now = Date.now();
    const expiresAt = now + this.sandboxMaxLifetimeMs();
    this.ctx.storage.sql.exec(
      "UPDATE review_target SET sandbox_expires_at = ? WHERE id = 1 AND sandbox_generation = ?",
      expiresAt,
      generation,
    );
    await this.#scheduleCleanupJob(
      generation,
      Math.min(now + this.sandboxCleanupPollMs(), expiresAt),
    );
  }

  async #scheduleCleanupJob(
    generation: number,
    time: number,
    extra?: { readonly pendingDestroy?: boolean; readonly retryCount?: number },
  ): Promise<void> {
    const payload: CleanupJobPayload = {
      generation,
      ...(extra?.pendingDestroy ? { pendingDestroy: true } : {}),
      ...(extra?.retryCount !== undefined ? { retryCount: extra.retryCount } : {}),
    };
    await this.lifecycle.jobs.push({
      id: SANDBOX_CLEANUP_JOB_ID,
      fn: SANDBOX_CLEANUP_JOB_FN,
      time,
      payload,
      singleflight: true,
      hungTimeoutSeconds: SANDBOX_CLEANUP_HUNG_TIMEOUT_SECONDS,
    });
  }

  async #destroySandbox(
    reason: SandboxDestroyReason,
    options: {
      readonly expectedGeneration?: number;
      readonly forceAbort?: boolean;
      readonly swallowErrors?: boolean;
    } = {},
  ): Promise<{ readonly destroyed: boolean }> {
    const previous = this.#inflightCleanup;
    const run = async (): Promise<{ readonly destroyed: boolean }> => {
      if (previous) {
        await previous;
      }

      const target = this.#getTarget();
      if (!target?.sandboxActive) {
        await this.lifecycle.jobs.cancel(SANDBOX_CLEANUP_JOB_ID);
        return { destroyed: false };
      }
      if (
        options.expectedGeneration !== undefined &&
        target.sandboxGeneration !== options.expectedGeneration
      ) {
        return { destroyed: false };
      }

      const nextGeneration = target.sandboxGeneration + 1;
      if (options.forceAbort) {
        // 強制破棄時は先に sandbox_active = 0・世代更新を確定させ、Pi によるゾンビ再生成を防ぐ
        this.ctx.storage.sql.exec(
          `UPDATE review_target
           SET checked_out_sha = NULL,
               test_commands_json = '[]',
               sandbox_active = 0,
               sandbox_generation = ?,
               sandbox_expires_at = NULL
           WHERE id = 1`,
          nextGeneration,
        );
      } else {
        this.ctx.storage.sql.exec(
          `UPDATE review_target
           SET checked_out_sha = NULL,
               test_commands_json = '[]',
               sandbox_generation = ?
           WHERE id = 1`,
          nextGeneration,
        );
      }

      // RUNNER.destroy() 待機中に DO が退避・再起動・ハングした場合でも世代不一致で
      // クリーンアップジョブが自己消滅しないよう、RPC 実行前に新世代の pendingDestroy を永続化する。
      await this.#scheduleCleanupJob(
        nextGeneration,
        Date.now() + this.sandboxDestroyRetryBaseDelayMs(),
        { pendingDestroy: true, retryCount: 0 },
      );

      const sandboxId = this.ctx.id.toString();
      // 強制破棄時は abort() を先に開始しつつ待たずに RUNNER.destroy() で実行中 RPC を切断し、
      // デッドロックを回避してから上限時間付きで abort 完了を待つ
      const abortPromise = options.forceAbort
        ? this.harness.abort().catch((error: unknown) => {
            console.error({
              event: "orchestrator.sandbox.abort_error",
              sandboxId,
              reason,
              error: error instanceof Error ? error.message : String(error),
            });
          })
        : null;

      try {
        await this.env.RUNNER.destroy(sandboxId);
      } catch (error) {
        const retryCount = 1;
        console.error({
          event: "orchestrator.sandbox.destroy_failed",
          sandboxId,
          reason,
          retryCount,
          error: error instanceof Error ? error.message : String(error),
        });
        const retryAt = Date.now() + this.sandboxDestroyRetryBaseDelayMs();
        await this.#scheduleCleanupJob(nextGeneration, retryAt, {
          pendingDestroy: true,
          retryCount,
        });
        if (abortPromise) {
          await waitWithTimeout(abortPromise, ABORT_WAIT_TIMEOUT_MS);
        }
        if (options.swallowErrors) {
          return { destroyed: false };
        }
        throw error;
      }

      this.ctx.storage.sql.exec(
        "UPDATE review_target SET sandbox_active = 0, sandbox_expires_at = NULL WHERE id = 1 AND sandbox_generation = ?",
        nextGeneration,
      );
      await this.lifecycle.jobs.cancel(SANDBOX_CLEANUP_JOB_ID);
      if (abortPromise) {
        await waitWithTimeout(abortPromise, ABORT_WAIT_TIMEOUT_MS);
      }
      console.info({
        event: "orchestrator.sandbox.destroyed",
        sandboxId,
        reason,
      });
      return { destroyed: true };
    };

    const promise = run();
    const tracked = promise.then(
      () => undefined,
      () => undefined,
    );
    this.#inflightCleanup = tracked;
    tracked.finally(() => {
      if (this.#inflightCleanup === tracked) {
        this.#inflightCleanup = null;
      }
    });
    return promise;
  }

  async #retryPendingDestroy(
    expectedGeneration: number,
    previousRetryCount: number,
  ): Promise<void> {
    const previous = this.#inflightCleanup;
    const run = async (): Promise<void> => {
      if (previous) {
        await previous;
      }
      const target = this.#getTarget();
      if (!target || target.sandboxGeneration !== expectedGeneration) {
        return;
      }
      const sandboxId = this.ctx.id.toString();
      try {
        await this.env.RUNNER.destroy(sandboxId);
        this.ctx.storage.sql.exec(
          "UPDATE review_target SET sandbox_active = 0, sandbox_expires_at = NULL WHERE id = 1 AND sandbox_generation = ?",
          expectedGeneration,
        );
        console.info({
          event: "orchestrator.sandbox.destroyed",
          sandboxId,
          reason: "retry_succeeded",
        });
      } catch (error) {
        const retryCount = previousRetryCount + 1;
        console.error({
          event: "orchestrator.sandbox.destroy_failed",
          sandboxId,
          reason: "retry",
          retryCount,
          error: error instanceof Error ? error.message : String(error),
        });
        if (retryCount <= DESTROY_MAX_RETRIES) {
          const backoffMs = this.sandboxDestroyRetryBaseDelayMs() * 2 ** (retryCount - 1);
          await this.#scheduleCleanupJob(expectedGeneration, Date.now() + backoffMs, {
            pendingDestroy: true,
            retryCount,
          });
          return;
        }
        // 最大リトライ到達後は Runner 側 sleepAfter の自動停止に委ねる
        this.ctx.storage.sql.exec(
          "UPDATE review_target SET sandbox_active = 0, sandbox_expires_at = NULL WHERE id = 1 AND sandbox_generation = ?",
          expectedGeneration,
        );
      }
    };

    const tracked = run();
    this.#inflightCleanup = tracked;
    tracked.finally(() => {
      if (this.#inflightCleanup === tracked) {
        this.#inflightCleanup = null;
      }
    });
    await tracked;
  }

  #hasDelivery(deliveryId: string): boolean {
    const row = this.ctx.storage.sql
      .exec<{ delivery_id: string }>(
        "SELECT delivery_id FROM review_deliveries WHERE delivery_id = ?",
        deliveryId,
      )
      .toArray()[0];
    return row !== undefined;
  }

  #recordDelivery(deliveryId: string): void {
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO review_deliveries (delivery_id, created_at) VALUES (?, ?)",
      deliveryId,
      Date.now(),
    );
  }

  #getInstallationToken(installationId: number): Promise<string> {
    return issueInstallationToken({
      appId: this.env.GITHUB_APP_ID,
      privateKey: this.env.GITHUB_APP_PRIVATE_KEY,
      installationId,
    });
  }

  #getCheckoutToken(installationId: number, repositoryName: string): Promise<string> {
    return issueInstallationToken(
      {
        appId: this.env.GITHUB_APP_ID,
        privateKey: this.env.GITHUB_APP_PRIVATE_KEY,
        installationId,
      },
      {
        repositories: [repositoryName],
        permissions: { contents: "read" },
      },
    );
  }

  #saveTarget(request: ReviewRequest): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO review_target (id, repository, pull_number, head_sha, installation_id, checked_out_sha)
       VALUES (1, ?, ?, ?, ?, NULL)
       ON CONFLICT(id) DO UPDATE SET
         repository = excluded.repository,
         pull_number = excluded.pull_number,
         head_sha = excluded.head_sha,
         installation_id = CASE
           WHEN excluded.installation_id != 0 THEN excluded.installation_id
           ELSE review_target.installation_id
         END`,
      request.repository,
      request.pullNumber,
      request.headSha,
      request.installationId ?? 0,
    );
  }

  #getTarget(): ReviewTarget | null {
    const row = this.ctx.storage.sql
      .exec<{
        repository: string;
        pull_number: number;
        head_sha: string;
        installation_id: number;
        checked_out_sha: string | null;
        test_commands_json: string;
        sandbox_active: number;
        sandbox_generation: number;
        sandbox_expires_at: number | null;
      }>(
        `SELECT repository, pull_number, head_sha, installation_id, checked_out_sha,
                test_commands_json, sandbox_active, sandbox_generation, sandbox_expires_at
         FROM review_target WHERE id = 1`,
      )
      .toArray()[0];
    if (!row) {
      return null;
    }
    return {
      repository: row.repository,
      pullNumber: row.pull_number,
      headSha: row.head_sha,
      installationId: row.installation_id,
      checkedOutSha: row.checked_out_sha,
      testCommands: parseStringArray(row.test_commands_json),
      sandboxActive: row.sandbox_active === 1,
      sandboxGeneration: row.sandbox_generation,
      sandboxExpiresAt: row.sandbox_expires_at,
    };
  }

  #requireTarget(): ReviewTarget {
    const target = this.#getTarget();
    if (!target) {
      throw new Error("review target is not initialized; call start() first");
    }
    return target;
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

function buildReviewPrompt(request: ReviewRequest, testCommands: readonly string[]): string {
  const base = `${request.repository} の Pull Request #${request.pullNumber}（head: ${request.headSha}）をレビューしてください。`;
  if (testCommands.length === 0) {
    return base;
  }
  return `${base}\nテストコマンドの候補: ${testCommands.join(", ")}`;
}

function parseStringArray(raw: string): string[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.filter((item): item is string => typeof item === "string");
}

function extractRepositoryName(fullRepository: string): string {
  const slashIndex = fullRepository.indexOf("/");
  if (slashIndex === -1 || slashIndex === fullRepository.length - 1) {
    throw new Error(`invalid repository: ${fullRepository}`);
  }
  return fullRepository.slice(slashIndex + 1);
}

function parseCleanupJobPayload(raw: unknown): CleanupJobPayload | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.generation !== "number" || !Number.isInteger(record.generation)) {
    return null;
  }
  return {
    generation: record.generation,
    ...(record.pendingDestroy === true ? { pendingDestroy: true } : {}),
    ...(typeof record.retryCount === "number" && Number.isInteger(record.retryCount)
      ? { retryCount: record.retryCount }
      : {}),
  };
}

async function waitWithTimeout(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function redactSecrets(input: string, secrets: readonly string[]): string {
  let output = input;
  for (const secret of secrets) {
    if (secret.length > 0) {
      output = output.replaceAll(secret, "[REDACTED]");
    }
  }
  return output;
}
