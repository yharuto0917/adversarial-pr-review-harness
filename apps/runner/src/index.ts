import { WorkerEntrypoint } from "cloudflare:workers";
import { ContainerProxy, getSandbox, Sandbox } from "@cloudflare/sandbox";
import type { ExecResult, SandboxExecOptions, SandboxService } from "@repo/harness";

import {
  CHECKOUT_EGRESS_TTL_MS,
  type CheckoutEgressParams,
  type EgressPhase,
  handleOutboundRequest,
  INSTALL_EGRESS_TTL_MS,
  type InstallEgressParams,
  type LockedEgressParams,
  parseExtraAllowedHosts,
} from "./egress.js";
import {
  CONTAINER_STARTUP_BUFFER_MS,
  computeOuterTimeoutMs,
  extractTimedOutResult,
  resolveExecTimeoutMs,
  TIMEOUT_KILL_GRACE_SECONDS,
  wrapCommandWithTimeout,
} from "./timeout.js";

/** コンテナが無通信のまま放置された場合に自動スリープするまでの時間（最終安全ネット）。 */
export const SANDBOX_SLEEP_AFTER = "10m";

// 外向き HTTP/HTTPS インターセプトのために Worker エントリから再エクスポート必須
export { ContainerProxy };

export interface RunnerEnv {
  readonly Sandbox: DurableObjectNamespace<ReviewSandbox>;
  /** install フェーズで既定レジストリ以外に追加許可する公開 FQDN（カンマ区切り）。 */
  readonly SANDBOX_EXTRA_ALLOWED_HOSTS?: string;
}

interface CheckoutAuthState {
  readonly tokenId: string;
  readonly repository: string;
  readonly authorization: string;
  readonly expiresAt: number;
}

/**
 * レビュー実行用の Sandbox サブクラス。
 * Container を持つ Durable Object なので、Worker エントリから re-export する。
 *
 * デフォルトで外向き通信を全遮断 (`enableInternet = false`, `interceptHttps = true`,
 * `outbound = locked`) とし、`checkout` / `install` の単一コマンド実行中のみ排他ロック＋TTL 付きで
 * 最小限の宛先を許可する。すべての外向き HTTP/HTTPS 通信は ContainerProxy 経由で監査ログへ記録される。
 */
export class ReviewSandbox extends Sandbox<RunnerEnv> {
  override enableInternet = false;
  override interceptHttps = true;
  override sleepAfter = SANDBOX_SLEEP_AFTER;

  /**
   * checkout 中のみ DO のオンメモリに一時保持する GitHub 認証ヘッダ。
   * Container.setOutboundHandler の params は DO KV に平文永続化されるため、
   * トークン本体は絶対に params やストレージに保存しない。
   */
  #checkoutAuth: CheckoutAuthState | null = null;

  #activeLockedOps = 0;
  #exclusiveActive = false;
  #egressPoisoned = false;
  #destroyEpoch = 0;
  readonly #exclusiveWaiters: Array<() => void> = [];
  readonly #lockedWaiters: Array<() => void> = [];

  constructor(ctx: ConstructorParameters<typeof Sandbox<RunnerEnv>>[0], env: RunnerEnv) {
    super(ctx, env);
    // DO の再起動・クラッシュ・退避からの復帰時に、KV へ残留した checkout / install 設定を
    // 起動直後に必ず locked へリセットし fail-closed を保証する。
    // Container 基底クラスの blockConcurrencyWhile は scheduleNextAlarm() 完了後に
    // usingInterception = true を立てるため、ここで明示的に有効化してからリセットする。
    this.ctx.blockConcurrencyWhile(async () => {
      this.usingInterception = true;
      await this.applyOutboundInterceptionPromise;
      await this.setOutboundHandler("locked");
    });
  }

  /**
   * ContainerProxy の checkout ハンドラから RPC 経由で呼ばれるオンメモリ認証解決。
   * checkout 実行中の exec() 待機中に再入呼び出しされるため、排他ゲートは通さない。
   */
  async getCheckoutAuthorization(tokenId: string, repository: string): Promise<string | null> {
    const auth = this.#checkoutAuth;
    if (!auth) {
      return null;
    }
    if (Date.now() > auth.expiresAt) {
      this.#checkoutAuth = null;
      return null;
    }
    if (auth.tokenId !== tokenId || auth.repository !== repository.toLowerCase()) {
      return null;
    }
    return auth.authorization;
  }

  /**
   * 外向き通信ポリシー・排他制御・実行時間上限を伴ってコマンドを実行する。
   * - `locked`（省略時含む）: 通常ゲート（排他フェーズ中は待機）で全遮断のまま実行する。
   * - `checkout` / `install`: 排他ゲートを取得し、TTL 付きポリシーを一時適用して実行後、
   *   成否に関わらず必ずオンメモリ認証を破棄して `locked` へ復帰する。
   */
  async execWithEgress(
    command: string,
    options?: SandboxExecOptions,
    logicalSandboxId?: string,
  ): Promise<ExecResult> {
    const egress = options?.egress;
    const phase: EgressPhase = egress?.profile ?? "locked";
    // 不正な timeoutMs でゲート待機やコンテナ破棄が走らないよう事前に検証・解決する
    const timeoutMs = resolveExecTimeoutMs(phase, options?.timeoutMs);
    // ゲート待機前に破棄世代を捕捉し、待機中に destroyGuarded() が走った場合の復活・egress 再開放を防ぐ
    const entryEpoch = this.#destroyEpoch;

    if (!egress || egress.profile === "locked") {
      return this.#withLockedGate(entryEpoch, () =>
        this.#execTimed(command, timeoutMs, entryEpoch, "locked"),
      );
    }

    if (egress.profile === "checkout") {
      return this.#withExclusiveGate(entryEpoch, "checkout", async () => {
        if (egress.resetContainer) {
          await this.destroy();
          this.#assertNotDestroyedDuringPhase(entryEpoch, "checkout");
        }
        // resetContainer 時はコンテナのコールドスタート時間を挟むため、起動予算込みで TTL を確保する
        // （完了・失敗時は finally で即時失効・locked 復帰されるため実効的な開放窓は増えない）
        const egressTtlMs = egress.resetContainer
          ? Math.max(
              CHECKOUT_EGRESS_TTL_MS,
              timeoutMs + CONTAINER_STARTUP_BUFFER_MS + TIMEOUT_KILL_GRACE_SECONDS * 1_000,
            )
          : CHECKOUT_EGRESS_TTL_MS;
        const expiresAt = Date.now() + egressTtlMs;
        let tokenId: string | undefined;
        if (egress.githubToken !== undefined && egress.githubToken.length > 0) {
          tokenId = crypto.randomUUID();
          this.#checkoutAuth = {
            tokenId,
            repository: egress.repository.toLowerCase(),
            authorization: `Basic ${btoa(`x-access-token:${egress.githubToken}`)}`,
            expiresAt,
          };
        }
        const params: CheckoutEgressParams = {
          repository: egress.repository,
          expiresAt,
          ...(tokenId !== undefined ? { tokenId } : {}),
          ...(logicalSandboxId !== undefined ? { logicalSandboxId } : {}),
        };
        try {
          await this.setOutboundHandler("checkout", params);
          this.#assertNotDestroyedDuringPhase(entryEpoch, "checkout");
          return await this.#execTimed(command, timeoutMs, entryEpoch, "checkout");
        } finally {
          this.#checkoutAuth = null;
          await this.#resetToLocked(logicalSandboxId);
        }
      });
    }

    return this.#withExclusiveGate(entryEpoch, "install", async () => {
      const expiresAt = Date.now() + INSTALL_EGRESS_TTL_MS;
      const params: InstallEgressParams = {
        expiresAt,
        ...(logicalSandboxId !== undefined ? { logicalSandboxId } : {}),
      };
      try {
        await this.setOutboundHandler("install", params);
        this.#assertNotDestroyedDuringPhase(entryEpoch, "install");
        return await this.#execTimed(command, timeoutMs, entryEpoch, "install");
      } finally {
        await this.#resetToLocked(logicalSandboxId);
      }
    });
  }

  /**
   * サンドボックスコンテナを安全に破棄する。
   * `#egressPoisoned` 状態やハング中の排他フェーズでも破棄をブロックしないようゲートは経由せず、
   * オンメモリ認証のクリアと `locked` 復帰試行の後に必ず `this.destroy()` を実行する。
   */
  async destroyGuarded(logicalSandboxId?: string): Promise<void> {
    this.#destroyEpoch += 1;
    this.#checkoutAuth = null;
    const startedAt = Date.now();
    let resetError: string | undefined;
    try {
      try {
        await this.applyOutboundInterceptionPromise;
        if (logicalSandboxId !== undefined) {
          await this.setOutboundHandler("locked", {
            logicalSandboxId,
          } satisfies LockedEgressParams);
        } else {
          await this.setOutboundHandler("locked");
        }
      } catch (error) {
        resetError = error instanceof Error ? error.message : String(error);
      }
      await this.destroy();
      console.info({
        event: "sandbox.lifecycle.destroy",
        outcome: "success",
        ...(logicalSandboxId !== undefined ? { logicalSandboxId } : {}),
        ...(resetError !== undefined ? { resetError } : {}),
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      console.error({
        event: "sandbox.lifecycle.destroy",
        outcome: "error",
        ...(logicalSandboxId !== undefined ? { logicalSandboxId } : {}),
        ...(resetError !== undefined ? { resetError } : {}),
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async #execTimed(
    command: string,
    timeoutMs: number,
    expectedEpoch?: number,
    phase?: EgressPhase,
  ): Promise<ExecResult> {
    const nonce = crypto.randomUUID();
    const wrapped = wrapCommandWithTimeout(command, timeoutMs, nonce);
    const outerTimeoutMs = computeOuterTimeoutMs(timeoutMs);
    const { stdout, stderr, exitCode } = await this.exec(wrapped, { timeout: outerTimeoutMs });
    if (expectedEpoch !== undefined && phase !== undefined) {
      this.#assertNotDestroyedDuringPhase(expectedEpoch, phase);
    }
    return extractTimedOutResult({ stdout, stderr, exitCode }, nonce, timeoutMs);
  }

  #assertNotDestroyedDuringPhase(expectedEpoch: number, phase: EgressPhase): void {
    if (this.#destroyEpoch !== expectedEpoch) {
      throw new Error(`sandbox was destroyed during ${phase} phase`);
    }
  }

  /** 排他フェーズ（checkout / install）と競合しないようゲート経由でファイルを読み取る。 */
  async readFileGuarded(path: string): Promise<string> {
    const entryEpoch = this.#destroyEpoch;
    return this.#withLockedGate(entryEpoch, async () => {
      const file = await this.readFile(path);
      this.#assertNotDestroyedDuringPhase(entryEpoch, "locked");
      return file.content;
    });
  }

  /** 排他フェーズ（checkout / install）と競合しないようゲート経由でファイルを書き込む。 */
  async writeFileGuarded(path: string, content: string): Promise<void> {
    const entryEpoch = this.#destroyEpoch;
    await this.#withLockedGate(entryEpoch, async () => {
      await this.writeFile(path, content);
      this.#assertNotDestroyedDuringPhase(entryEpoch, "locked");
    });
  }

  /** 排他フェーズ（checkout / install）と競合しないようゲート経由でファイル一覧を取得する。 */
  async listFilesGuarded(path: string): Promise<string[]> {
    const entryEpoch = this.#destroyEpoch;
    return this.#withLockedGate(entryEpoch, async () => {
      const listing = await this.listFiles(path);
      this.#assertNotDestroyedDuringPhase(entryEpoch, "locked");
      return listing.files.map((file) => file.name);
    });
  }

  async #resetToLocked(logicalSandboxId?: string): Promise<void> {
    const applyLocked = () =>
      logicalSandboxId !== undefined
        ? this.setOutboundHandler("locked", { logicalSandboxId } satisfies LockedEgressParams)
        : this.setOutboundHandler("locked");

    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await applyLocked();
        return;
      } catch (error) {
        lastError = error;
      }
    }

    // locked への復帰が最終的に失敗した場合、fail-open を防ぐため以後の操作をすべて遮断し、
    // コンテナ破棄と DO 中断を試みる。
    this.#egressPoisoned = true;
    console.error({
      event: "sandbox.egress.reset_failed",
      ...(logicalSandboxId !== undefined ? { logicalSandboxId } : {}),
      error: lastError instanceof Error ? lastError.message : String(lastError),
    });
    try {
      await this.destroy();
    } catch {
      // コンテナ破棄の二次エラーより元の復帰失敗を優先する
    }
    this.ctx.abort?.("failed to restore locked sandbox egress policy");
    throw lastError;
  }

  #assertEgressHealthy(): void {
    if (this.#egressPoisoned) {
      throw new Error(
        "sandbox egress policy is in a poisoned state after failing to restore locked mode",
      );
    }
  }

  async #withLockedGate<T>(entryEpoch: number, fn: () => Promise<T>): Promise<T> {
    this.#assertEgressHealthy();
    this.#assertNotDestroyedDuringPhase(entryEpoch, "locked");
    if (this.#exclusiveActive || this.#exclusiveWaiters.length > 0) {
      await new Promise<void>((resolve) => {
        this.#lockedWaiters.push(resolve);
      });
    } else {
      this.#activeLockedOps += 1;
    }
    try {
      this.#assertEgressHealthy();
      await this.applyOutboundInterceptionPromise;
      this.#assertNotDestroyedDuringPhase(entryEpoch, "locked");
      return await fn();
    } finally {
      this.#activeLockedOps -= 1;
      this.#drainGate();
    }
  }

  async #withExclusiveGate<T>(
    entryEpoch: number,
    phase: Extract<EgressPhase, "checkout" | "install">,
    fn: () => Promise<T>,
  ): Promise<T> {
    this.#assertEgressHealthy();
    this.#assertNotDestroyedDuringPhase(entryEpoch, phase);
    if (this.#exclusiveActive || this.#activeLockedOps > 0) {
      await new Promise<void>((resolve) => {
        this.#exclusiveWaiters.push(resolve);
      });
    } else {
      this.#exclusiveActive = true;
    }
    try {
      this.#assertEgressHealthy();
      await this.applyOutboundInterceptionPromise;
      this.#assertNotDestroyedDuringPhase(entryEpoch, phase);
      return await fn();
    } finally {
      this.#exclusiveActive = false;
      this.#drainGate();
    }
  }

  #drainGate(): void {
    if (this.#exclusiveActive) {
      return;
    }
    if (this.#exclusiveWaiters.length > 0) {
      if (this.#activeLockedOps === 0) {
        const next = this.#exclusiveWaiters.shift();
        if (next) {
          this.#exclusiveActive = true;
          next();
        }
      }
      return;
    }
    while (this.#lockedWaiters.length > 0) {
      const next = this.#lockedWaiters.shift();
      if (next) {
        this.#activeLockedOps += 1;
        next();
      }
    }
  }
}

function asLockedParams(raw: unknown): LockedEgressParams | undefined {
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }
  const logicalSandboxId = (raw as { logicalSandboxId?: unknown }).logicalSandboxId;
  return typeof logicalSandboxId === "string" ? { logicalSandboxId } : undefined;
}

function asCheckoutParams(raw: unknown): CheckoutEgressParams | undefined {
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.repository !== "string" || typeof record.expiresAt !== "number") {
    return undefined;
  }
  return {
    repository: record.repository,
    expiresAt: record.expiresAt,
    ...(typeof record.tokenId === "string" ? { tokenId: record.tokenId } : {}),
    ...(typeof record.logicalSandboxId === "string"
      ? { logicalSandboxId: record.logicalSandboxId }
      : {}),
  };
}

function asInstallParams(raw: unknown): InstallEgressParams | undefined {
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.expiresAt !== "number") {
    return undefined;
  }
  return {
    expiresAt: record.expiresAt,
    ...(typeof record.logicalSandboxId === "string"
      ? { logicalSandboxId: record.logicalSandboxId }
      : {}),
  };
}

const lockedOutboundHandler = (
  request: Request,
  _env: unknown,
  ctx: { readonly containerId: string; readonly params?: unknown },
): Promise<Response> =>
  handleOutboundRequest(
    request,
    { phase: "locked", params: asLockedParams(ctx.params) },
    { containerId: ctx.containerId },
  );

// 重要: TypeScript target=ES2022 ではクラス本体内の `static outbound = ...` が
// 親クラス Container の static setter をシャドウしてしまうため、必ずクラス外で代入する。
ReviewSandbox.outboundHandlers = {
  locked: lockedOutboundHandler,
  checkout: (request, env, ctx) => {
    const runnerEnv = env as unknown as RunnerEnv;
    return handleOutboundRequest(
      request,
      { phase: "checkout", params: asCheckoutParams(ctx.params) },
      { containerId: ctx.containerId },
      {
        resolveCheckoutAuthorization: async (tokenId, repository) => {
          const stub = runnerEnv.Sandbox.get(runnerEnv.Sandbox.idFromString(ctx.containerId));
          return stub.getCheckoutAuthorization(tokenId, repository);
        },
      },
    );
  },
  install: (request, env, ctx) => {
    const runnerEnv = env as unknown as RunnerEnv;
    const installParams = asInstallParams(ctx.params);
    let extraInstallHosts: readonly string[];
    try {
      extraInstallHosts = parseExtraAllowedHosts(runnerEnv.SANDBOX_EXTRA_ALLOWED_HOSTS);
    } catch (error) {
      console.error({
        event: "sandbox.egress.config_error",
        ...(installParams?.logicalSandboxId !== undefined
          ? { logicalSandboxId: installParams.logicalSandboxId }
          : {}),
        error: error instanceof Error ? error.message : String(error),
      });
      // 不正な追加ホスト設定時は fail-closed（expiresAt: NaN により invalid_policy_params で 403、
      // logicalSandboxId は監査ログへ引き継ぐ）
      return handleOutboundRequest(
        request,
        {
          phase: "install",
          params: {
            expiresAt: Number.NaN,
            ...(installParams?.logicalSandboxId !== undefined
              ? { logicalSandboxId: installParams.logicalSandboxId }
              : {}),
          },
        },
        { containerId: ctx.containerId },
      );
    }
    return handleOutboundRequest(
      request,
      { phase: "install", params: installParams },
      { containerId: ctx.containerId },
      { extraInstallHosts },
    );
  },
};

ReviewSandbox.outbound = lockedOutboundHandler;

/**
 * gateway の Durable Object から service binding 経由で呼ばれる RPC の入口。
 * Pi のツール（exec / read_file / write_file / list_files）および
 * ReviewOrchestrator のセットアップ（checkout / install）の実体がここになる。
 */
export class SandboxEntrypoint extends WorkerEntrypoint<RunnerEnv> implements SandboxService {
  async exec(
    sandboxId: string,
    command: string,
    options?: SandboxExecOptions,
  ): Promise<ExecResult> {
    return this.#sandbox(sandboxId).execWithEgress(command, options, sandboxId);
  }

  async readFile(sandboxId: string, path: string): Promise<string> {
    return this.#sandbox(sandboxId).readFileGuarded(path);
  }

  async writeFile(sandboxId: string, path: string, content: string): Promise<void> {
    await this.#sandbox(sandboxId).writeFileGuarded(path, content);
  }

  async listFiles(sandboxId: string, path: string): Promise<string[]> {
    return this.#sandbox(sandboxId).listFilesGuarded(path);
  }

  async destroy(sandboxId: string): Promise<void> {
    await this.#sandbox(sandboxId).destroyGuarded(sandboxId);
  }

  #sandbox(sandboxId: string) {
    // DurableObjectId.toString() は 64 文字だが、@cloudflare/sandbox は
    // DNS ラベル長に合わせて 63 文字までしか受け付けない。
    return getSandbox(this.env.Sandbox, sandboxId.slice(0, 63), { normalizeId: true });
  }
}

export default {
  // 公開する HTTP の口は無い。呼び出しはすべて SandboxEntrypoint への RPC で受ける
  async fetch(): Promise<Response> {
    return new Response(null, { status: 404 });
  },
} satisfies ExportedHandler<RunnerEnv>;
