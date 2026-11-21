import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type MockOutboundHandler = (
  request: Request,
  env: unknown,
  ctx: { containerId: string; className: string; params?: unknown },
) => Promise<Response> | Response;

const outboundHandlersRegistry = new Map<string, Record<string, MockOutboundHandler>>();
const defaultOutboundRegistry = new Map<string, MockOutboundHandler>();
const setterCalls: string[] = [];

const sandboxStub = {
  execWithEgress: vi.fn(),
  readFileGuarded: vi.fn(),
  writeFileGuarded: vi.fn(),
  listFilesGuarded: vi.fn(),
  destroyGuarded: vi.fn(),
};
const getSandboxMock = vi.fn((..._args: unknown[]) => sandboxStub);

class MockContainerProxy {}

interface MockDoCtx {
  blockConcurrencyWhile: (cb: () => Promise<void>) => Promise<void>;
  abort: ReturnType<typeof vi.fn>;
}

class MockSandboxBase {
  enableInternet = true;
  interceptHttps = false;
  sleepAfter: string | number = "10m";
  usingInterception = false;
  applyOutboundInterceptionPromise: Promise<void> = Promise.resolve();
  appliedInterceptions: Array<{ method: string; params: unknown }> = [];
  ctx: MockDoCtx;
  env: unknown;
  exec = vi.fn();
  readFile = vi.fn();
  writeFile = vi.fn();
  listFiles = vi.fn();
  destroy = vi.fn(async () => {});
  setOutboundHandler = vi.fn(async (method: string, params?: unknown) => {
    // 本物の Container.refreshOutboundInterception() と同じ挙動:
    // usingInterception === false の間は KV 永続化・コンテナ適用が空振りする。
    if (!this.usingInterception) {
      return;
    }
    this.appliedInterceptions.push({ method, params });
  });

  constructor(ctx: MockDoCtx, env: unknown) {
    this.ctx = ctx;
    this.env = env;
    // 本物の Container コンストラクタの遅延 usingInterception 初期化を再現する
    this.ctx.blockConcurrencyWhile(async () => {
      await Promise.resolve();
      this.usingInterception = true;
    });
  }
}

Object.defineProperties(MockSandboxBase, {
  outboundHandlers: {
    configurable: true,
    get(this: { name: string }): Record<string, MockOutboundHandler> | undefined {
      return outboundHandlersRegistry.get(this.name);
    },
    set(this: { name: string }, handlers: Record<string, MockOutboundHandler>) {
      setterCalls.push(`outboundHandlers:${this.name}`);
      const existing = outboundHandlersRegistry.get(this.name) ?? {};
      outboundHandlersRegistry.set(this.name, { ...existing, ...handlers });
    },
  },
  outbound: {
    configurable: true,
    get(this: { name: string }): MockOutboundHandler | undefined {
      return defaultOutboundRegistry.get(this.name);
    },
    set(this: { name: string }, handler: MockOutboundHandler) {
      setterCalls.push(`outbound:${this.name}`);
      defaultOutboundRegistry.set(this.name, handler);
    },
  },
});

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    env: unknown;
    constructor(_ctx?: unknown, env?: unknown) {
      this.env = env;
    }
  },
}));

vi.mock("@cloudflare/sandbox", () => ({
  ContainerProxy: MockContainerProxy,
  Sandbox: MockSandboxBase,
  getSandbox: (...args: unknown[]) => getSandboxMock(...args),
}));

const { ContainerProxy, ReviewSandbox, SANDBOX_SLEEP_AFTER, SandboxEntrypoint } = await import(
  "./index.js"
);
const {
  CHECKOUT_EXEC_DEFAULT_TIMEOUT_MS,
  computeOuterTimeoutMs,
  INSTALL_EXEC_DEFAULT_TIMEOUT_MS,
  LOCKED_EXEC_DEFAULT_TIMEOUT_MS,
  LOCKED_EXEC_MAX_TIMEOUT_MS,
} = await import("./timeout.js");

function extractInnerCommand(wrapped: string): string {
  const match = wrapped.match(/bash -c '((?:[^']|'\\'')*)'/);
  return match?.[1]?.replaceAll("'\\''", "'") ?? wrapped;
}

interface MockSandboxMethods {
  readonly exec: ReturnType<typeof vi.fn>;
  readonly readFile: ReturnType<typeof vi.fn>;
  readonly writeFile: ReturnType<typeof vi.fn>;
  readonly listFiles: ReturnType<typeof vi.fn>;
  readonly destroy: ReturnType<typeof vi.fn>;
  readonly setOutboundHandler: ReturnType<typeof vi.fn>;
  readonly appliedInterceptions: Array<{ method: string; params: unknown }>;
}

function createReviewSandbox(envOverrides: Record<string, unknown> = {}) {
  const pendingInit: Promise<void>[] = [];
  const ctx: MockDoCtx = {
    blockConcurrencyWhile: vi.fn((cb: () => Promise<void>) => {
      const p = cb();
      pendingInit.push(p);
      return p;
    }),
    abort: vi.fn(),
  };
  const env = { Sandbox: {} as Env["Sandbox"], ...envOverrides };
  const instance = new ReviewSandbox(
    ctx as unknown as ConstructorParameters<typeof ReviewSandbox>[0],
    env,
  );
  const mocks = instance as unknown as MockSandboxMethods;
  return {
    instance,
    mocks,
    ctx,
    waitForInit: () => Promise.all(pendingInit),
  };
}

describe("ContainerProxy / ReviewSandbox static registration", () => {
  it("Worker エントリから ContainerProxy を再エクスポートする", () => {
    expect(ContainerProxy).toBe(MockContainerProxy);
  });

  it("ES2022 シャドウイングを起こさず、親クラスの static setter 経由で outbound / outboundHandlers を登録する", () => {
    expect(setterCalls).toContain("outboundHandlers:ReviewSandbox");
    expect(setterCalls).toContain("outbound:ReviewSandbox");
    expect(Object.hasOwn(ReviewSandbox, "outbound")).toBe(false);
    expect(Object.hasOwn(ReviewSandbox, "outboundHandlers")).toBe(false);

    const handlers = outboundHandlersRegistry.get("ReviewSandbox");
    expect(handlers).toBeDefined();
    expect(Object.keys(handlers ?? {}).sort()).toEqual(["checkout", "install", "locked"]);
    expect(defaultOutboundRegistry.get("ReviewSandbox")).toBeTypeOf("function");
  });
});

describe("ReviewSandbox", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("enableInternet=false, interceptHttps=true で初期化され、起動時に usingInterception 有効化の上で locked へ確実にリセットする", async () => {
    const { instance, mocks, waitForInit } = createReviewSandbox();
    await waitForInit();

    expect(instance.enableInternet).toBe(false);
    expect(instance.interceptHttps).toBe(true);
    expect(instance.sleepAfter).toBe(SANDBOX_SLEEP_AFTER);
    expect(instance.usingInterception).toBe(true);
    expect(mocks.setOutboundHandler).toHaveBeenCalledTimes(1);
    expect(mocks.setOutboundHandler).toHaveBeenCalledWith("locked");
    // 基底クラスの遅延初期化に負けず、実際にインターセプト適用まで到達していること
    expect(mocks.appliedInterceptions).toEqual([{ method: "locked", params: undefined }]);
  });

  it("checkout 実行時にコンテナ再作成・オンメモリトークン保持・完了後即破棄と locked 復帰を行う", async () => {
    const { instance, mocks, waitForInit } = createReviewSandbox();
    await waitForInit();
    mocks.setOutboundHandler.mockClear();

    let capturedTokenId: string | undefined;
    let resolvedAuthDuringExec: string | null = null;
    mocks.exec.mockImplementation(async () => {
      const checkoutCall = mocks.setOutboundHandler.mock.calls.find(
        ([method]) => method === "checkout",
      );
      const params = checkoutCall?.[1] as {
        repository: string;
        tokenId?: string;
        expiresAt: number;
      };
      // KV 永続化対象である params にトークン本体が含まれないことを保証する
      expect(JSON.stringify(params)).not.toContain("ghs_secret_checkout");
      expect(params.repository).toBe("Octo/Repo");
      expect(typeof params.tokenId).toBe("string");
      expect(params.expiresAt).toBeGreaterThan(Date.now());
      capturedTokenId = params.tokenId;

      // exec 実行中に ContainerProxy からの再入 RPC で認証ヘッダが取得できる
      resolvedAuthDuringExec = await instance.getCheckoutAuthorization(
        params.tokenId ?? "",
        "octo/repo",
      );
      // リポジトリ不一致やトークン ID 不一致は null を返す
      expect(
        await instance.getCheckoutAuthorization(params.tokenId ?? "", "octo/other"),
      ).toBeNull();
      expect(await instance.getCheckoutAuthorization("wrong-id", "octo/repo")).toBeNull();

      return { stdout: "", stderr: "", exitCode: 0 };
    });

    const result = await instance.execWithEgress(
      "git fetch",
      {
        egress: {
          profile: "checkout",
          repository: "Octo/Repo",
          githubToken: "ghs_secret_checkout",
          resetContainer: true,
        },
      },
      "sandbox-logical-1",
    );

    expect(result).toEqual({ stdout: "", stderr: "", exitCode: 0 });
    expect(mocks.destroy).toHaveBeenCalledTimes(1);
    expect(resolvedAuthDuringExec).toBe(`Basic ${btoa("x-access-token:ghs_secret_checkout")}`);
    // 実行完了後はオンメモリ認証が即破棄され、locked に戻っている
    expect(await instance.getCheckoutAuthorization(capturedTokenId ?? "", "octo/repo")).toBeNull();
    expect(mocks.setOutboundHandler.mock.calls.map(([method]) => method)).toEqual([
      "checkout",
      "locked",
    ]);
  });

  it("checkout / install 中に exec が失敗しても finally で確実に認証破棄と locked 復帰を行う", async () => {
    const { instance, mocks, waitForInit } = createReviewSandbox();
    await waitForInit();
    mocks.setOutboundHandler.mockClear();

    let capturedTokenId = "";
    mocks.exec.mockImplementationOnce(async () => {
      const params = mocks.setOutboundHandler.mock.calls[0]?.[1] as { tokenId?: string };
      capturedTokenId = params.tokenId ?? "";
      throw new Error("git network error");
    });

    await expect(
      instance.execWithEgress("git fetch", {
        egress: {
          profile: "checkout",
          repository: "octo/repo",
          githubToken: "ghs_secret_fail",
        },
      }),
    ).rejects.toThrow("git network error");

    expect(await instance.getCheckoutAuthorization(capturedTokenId, "octo/repo")).toBeNull();
    expect(mocks.setOutboundHandler.mock.calls.map(([method]) => method)).toEqual([
      "checkout",
      "locked",
    ]);

    mocks.setOutboundHandler.mockClear();
    mocks.exec.mockRejectedValueOnce(new Error("install failed"));

    await expect(
      instance.execWithEgress("pnpm install", { egress: { profile: "install" } }),
    ).rejects.toThrow("install failed");

    expect(mocks.setOutboundHandler.mock.calls.map(([method]) => method)).toEqual([
      "install",
      "locked",
    ]);
  });

  it("checkout / install 排他フェーズ中は並行の通常 exec や writeFile を待機させ、locked 復帰後に実行する", async () => {
    const { instance, mocks, waitForInit } = createReviewSandbox();
    await waitForInit();
    mocks.setOutboundHandler.mockClear();

    const timeline: string[] = [];
    let releaseInstall!: () => void;
    const installGate = new Promise<void>((resolve) => {
      releaseInstall = resolve;
    });

    mocks.setOutboundHandler.mockImplementation(async (method: string) => {
      timeline.push(`policy:${method}`);
    });
    mocks.exec.mockImplementation(async (wrappedCmd: string) => {
      const cmd = extractInnerCommand(wrappedCmd);
      timeline.push(`exec:start:${cmd}`);
      if (cmd === "pnpm install") {
        await installGate;
      }
      timeline.push(`exec:end:${cmd}`);
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    mocks.writeFile.mockImplementation(async (path: string) => {
      timeline.push(`write:${path}`);
      return { success: true, path };
    });

    const installPromise = instance.execWithEgress("pnpm install", {
      egress: { profile: "install" },
    });
    // install が exec に入るまでマイクロタスクを進める
    await vi.waitFor(() => {
      expect(timeline).toContain("exec:start:pnpm install");
    });

    const concurrentExec = instance.execWithEgress("curl https://evil.example");
    const concurrentWrite = instance.writeFileGuarded(".npmrc", "registry=https://evil.example");
    await Promise.resolve();

    // install 完了・locked 復帰までは並行操作が開始されない
    expect(timeline).toEqual(["policy:install", "exec:start:pnpm install"]);

    releaseInstall();
    await Promise.all([installPromise, concurrentExec, concurrentWrite]);

    expect(timeline.slice(0, 4)).toEqual([
      "policy:install",
      "exec:start:pnpm install",
      "exec:end:pnpm install",
      "policy:locked",
    ]);
    expect(timeline.indexOf("exec:start:curl https://evil.example")).toBeGreaterThan(
      timeline.indexOf("policy:locked"),
    );
    expect(timeline.indexOf("write:.npmrc")).toBeGreaterThan(timeline.indexOf("policy:locked"));
  });

  it("outboundHandlers.checkout は ReviewSandbox DO の getCheckoutAuthorization 経由でトークンを注入する", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const req = input as Request;
      expect(req.headers.get("authorization")).toBe("Basic Z2hzX29uX21lbW9yeQ==");
      return new Response("refs-ok", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const getCheckoutAuthorization = vi.fn(async () => "Basic Z2hzX29uX21lbW9yeQ==");
    const fakeEnv = {
      Sandbox: {
        idFromString: vi.fn((id: string) => `do-id:${id}`),
        get: vi.fn(() => ({ getCheckoutAuthorization })),
      },
    };
    const checkoutHandler = outboundHandlersRegistry.get("ReviewSandbox")?.checkout;
    expect(checkoutHandler).toBeDefined();

    const response = await checkoutHandler?.(
      new Request("https://github.com/octo/repo.git/info/refs?service=git-upload-pack"),
      fakeEnv,
      {
        containerId: "b".repeat(64),
        className: "ReviewSandbox",
        params: {
          repository: "octo/repo",
          tokenId: "tok-mem-1",
          expiresAt: Date.now() + 60_000,
        },
      },
    );

    expect(response?.status).toBe(200);
    expect(getCheckoutAuthorization).toHaveBeenCalledWith("tok-mem-1", "octo/repo");
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("outboundHandlers.install は SANDBOX_EXTRA_ALLOWED_HOSTS に不正値があると logicalSandboxId を引き継いで fail-closed で 403 を返す", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const installHandler = outboundHandlersRegistry.get("ReviewSandbox")?.install;
    expect(installHandler).toBeDefined();

    const response = await installHandler?.(
      new Request("https://registry.npmjs.org/vitest"),
      { SANDBOX_EXTRA_ALLOWED_HOSTS: "localhost,127.0.0.1" },
      {
        containerId: "c".repeat(64),
        className: "ReviewSandbox",
        params: { expiresAt: Date.now() + 60_000, logicalSandboxId: "logical-cfg-err" },
      },
    );

    expect(response?.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "sandbox.egress",
        decision: "deny",
        reason: "invalid_policy_params",
        logicalSandboxId: "logical-cfg-err",
      }),
    );
  });

  it("ReviewSandbox.outbound および outboundHandlers.locked は全通信を 403 拒否し監査ログを出力する", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const defaultHandler = defaultOutboundRegistry.get("ReviewSandbox");
    const lockedHandler = outboundHandlersRegistry.get("ReviewSandbox")?.locked;
    expect(defaultHandler).toBeDefined();
    expect(lockedHandler).toBeDefined();

    const res1 = await defaultHandler?.(
      new Request("https://github.com/octo/repo"),
      {},
      {
        containerId: "d".repeat(64),
        className: "ReviewSandbox",
      },
    );
    const res2 = await lockedHandler?.(
      new Request("https://registry.npmjs.org/vitest"),
      {},
      {
        containerId: "d".repeat(64),
        className: "ReviewSandbox",
        params: { logicalSandboxId: "logical-locked" },
      },
    );

    expect(res1?.status).toBe(403);
    expect(res2?.status).toBe(403);
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        event: "sandbox.egress",
        decision: "deny",
        reason: "phase_locked",
        logicalSandboxId: "logical-locked",
      }),
    );
  });

  it("getCheckoutAuthorization は有効期限超過後に null を返しオンメモリ認証を破棄する", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-11-20T00:00:00Z"));
      const { instance, mocks, waitForInit } = createReviewSandbox();
      await waitForInit();
      mocks.setOutboundHandler.mockClear();

      mocks.exec.mockImplementationOnce(async () => {
        const params = mocks.setOutboundHandler.mock.calls[0]?.[1] as { tokenId: string };
        expect(await instance.getCheckoutAuthorization(params.tokenId, "octo/repo")).toBe(
          `Basic ${btoa("x-access-token:ghs_ttl")}`,
        );
        // TTL (2 分) を超えるまで時計を進める
        vi.advanceTimersByTime(3 * 60 * 1_000);
        expect(await instance.getCheckoutAuthorization(params.tokenId, "octo/repo")).toBeNull();
        return { stdout: "", stderr: "", exitCode: 0 };
      });

      await instance.execWithEgress("git fetch", {
        egress: { profile: "checkout", repository: "octo/repo", githubToken: "ghs_ttl" },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("locked 復帰がリトライ後も失敗した場合はコンテナ破棄・DO 中断し、待機中および後続の操作をすべて fail-closed で遮断する", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { instance, mocks, ctx, waitForInit } = createReviewSandbox();
    await waitForInit();
    mocks.setOutboundHandler.mockClear();

    let releaseInstall!: () => void;
    const installGate = new Promise<void>((resolve) => {
      releaseInstall = resolve;
    });
    mocks.exec.mockImplementation(async (wrappedCmd: string) => {
      if (extractInnerCommand(wrappedCmd) === "pnpm install") {
        await installGate;
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    mocks.setOutboundHandler.mockImplementation(async (method: string) => {
      if (method === "locked") {
        throw new Error("intercept RPC failed");
      }
    });

    const installPromise = instance.execWithEgress("pnpm install", {
      egress: { profile: "install" },
    });
    await vi.waitFor(() => {
      expect(mocks.exec).toHaveBeenCalledTimes(1);
      expect(extractInnerCommand(String(mocks.exec.mock.calls[0]?.[0]))).toBe("pnpm install");
    });

    const queuedLockedExec = instance.execWithEgress("curl https://registry.npmjs.org/vitest");
    releaseInstall();

    await expect(installPromise).rejects.toThrow("intercept RPC failed");
    await expect(queuedLockedExec).rejects.toThrow(/poisoned state/);
    await expect(instance.execWithEgress("echo after")).rejects.toThrow(/poisoned state/);

    // リトライ含め locked 適用を 2 回試行し、失敗後に destroy と ctx.abort を実行する
    const lockedCalls = mocks.setOutboundHandler.mock.calls.filter(([m]) => m === "locked");
    expect(lockedCalls).toHaveLength(2);
    expect(mocks.destroy).toHaveBeenCalledTimes(1);
    expect(ctx.abort).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    // 待機していた通常 exec が install 許可のまま実行されていないこと
    expect(mocks.exec).toHaveBeenCalledTimes(1);
  });

  it("writer-preference: locked 実行中に exclusive が待機すると後続 locked を待たせ、exclusive 同士も直列化する", async () => {
    const { instance, mocks, waitForInit } = createReviewSandbox();
    await waitForInit();
    mocks.setOutboundHandler.mockClear();

    const timeline: string[] = [];
    let releaseFirstLocked!: () => void;
    let releaseFirstExclusive!: () => void;
    const firstLockedGate = new Promise<void>((resolve) => {
      releaseFirstLocked = resolve;
    });
    const firstExclusiveGate = new Promise<void>((resolve) => {
      releaseFirstExclusive = resolve;
    });

    mocks.exec.mockImplementation(async (wrappedCmd: string) => {
      const cmd = extractInnerCommand(wrappedCmd);
      timeline.push(`start:${cmd}`);
      if (cmd === "locked-1") await firstLockedGate;
      if (cmd === "exclusive-1") await firstExclusiveGate;
      timeline.push(`end:${cmd}`);
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    const l1 = instance.execWithEgress("locked-1");
    await vi.waitFor(() => expect(timeline).toContain("start:locked-1"));

    const e1 = instance.execWithEgress("exclusive-1", { egress: { profile: "install" } });
    const e2 = instance.execWithEgress("exclusive-2", { egress: { profile: "install" } });
    const l2 = instance.execWithEgress("locked-2");
    await Promise.resolve();

    // locked-1 実行中は exclusive も後続 locked-2 も始まらない
    expect(timeline).toEqual(["start:locked-1"]);

    releaseFirstLocked();
    await vi.waitFor(() => expect(timeline).toContain("start:exclusive-1"));
    expect(timeline).toEqual(["start:locked-1", "end:locked-1", "start:exclusive-1"]);

    releaseFirstExclusive();
    await Promise.all([l1, e1, e2, l2]);

    expect(timeline).toEqual([
      "start:locked-1",
      "end:locked-1",
      "start:exclusive-1",
      "end:exclusive-1",
      "start:exclusive-2",
      "end:exclusive-2",
      "start:locked-2",
      "end:locked-2",
    ]);
  });

  it("プロファイル別にコマンドタイムアウトを強制し、ラップコマンドとコールドスタート余裕込みの SDK timeout を渡す", async () => {
    const { instance, mocks, waitForInit } = createReviewSandbox();
    await waitForInit();
    mocks.exec.mockResolvedValue({ stdout: "ok", stderr: "", exitCode: 0 });

    await instance.execWithEgress("pnpm test");
    await instance.execWithEgress("pnpm test", { timeoutMs: 999_999 });
    await instance.execWithEgress("git fetch", {
      egress: { profile: "checkout", repository: "octo/repo" },
    });
    await instance.execWithEgress("pnpm install", { egress: { profile: "install" } });

    expect(mocks.exec.mock.calls).toEqual([
      [
        expect.stringContaining("timeout --kill-after=5s 60s bash -c 'pnpm test'"),
        { timeout: computeOuterTimeoutMs(LOCKED_EXEC_DEFAULT_TIMEOUT_MS) },
      ],
      [
        expect.stringContaining("timeout --kill-after=5s 120s bash -c 'pnpm test'"),
        { timeout: computeOuterTimeoutMs(LOCKED_EXEC_MAX_TIMEOUT_MS) },
      ],
      [
        expect.stringContaining("timeout --kill-after=5s 120s bash -c 'git fetch'"),
        { timeout: computeOuterTimeoutMs(CHECKOUT_EXEC_DEFAULT_TIMEOUT_MS) },
      ],
      [
        expect.stringContaining("timeout --kill-after=5s 300s bash -c 'pnpm install'"),
        { timeout: computeOuterTimeoutMs(INSTALL_EXEC_DEFAULT_TIMEOUT_MS) },
      ],
    ]);

    // 不正な timeoutMs は resetContainer 破棄や exec 実行の前に RangeError で拒否される
    mocks.destroy.mockClear();
    mocks.exec.mockClear();
    await expect(
      instance.execWithEgress("git fetch", {
        timeoutMs: Number.NaN,
        egress: { profile: "checkout", repository: "octo/repo", resetContainer: true },
      }),
    ).rejects.toThrow(RangeError);
    expect(mocks.destroy).not.toHaveBeenCalled();
    expect(mocks.exec).not.toHaveBeenCalled();
  });

  it("コンテナ側でタイムアウトマーカーが出力された場合は timedOut: true と exitCode: 124 に正規化する", async () => {
    const { instance, mocks, waitForInit } = createReviewSandbox();
    await waitForInit();
    mocks.exec.mockImplementationOnce(async (wrappedCmd: string) => {
      const markerMatch = wrappedCmd.match(/__SANDBOX_TIMEOUT_[0-9a-f-]+__/);
      expect(markerMatch?.[0]).toBeDefined();
      return {
        stdout: "before hang",
        stderr: `partial err\n${markerMatch?.[0]}\n`,
        exitCode: 124,
      };
    });

    const result = await instance.execWithEgress("sleep 999", { timeoutMs: 2_000 });

    expect(result).toEqual({
      stdout: "before hang",
      stderr: "partial err\ncommand timed out after 2000ms",
      exitCode: 124,
      timedOut: true,
    });
  });

  it("destroyGuarded は認証破棄・locked 復帰試行のうえ必ず destroy を実行し、setOutboundHandler 失敗時や poisoned 状態でも破棄できる", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { instance, mocks, waitForInit } = createReviewSandbox();
    await waitForInit();
    mocks.setOutboundHandler.mockClear();

    // 1. setOutboundHandler("locked") が失敗しても destroy() は必ず呼ばれる
    mocks.setOutboundHandler.mockRejectedValueOnce(new Error("locked reset failed"));
    await instance.destroyGuarded("sandbox-logical-destroy");

    expect(mocks.destroy).toHaveBeenCalledTimes(1);
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "sandbox.lifecycle.destroy",
        outcome: "success",
        logicalSandboxId: "sandbox-logical-destroy",
        resetError: "locked reset failed",
      }),
    );

    // 2. locked 復帰失敗で poisoned 状態になった後でも destroyGuarded() は破棄できる
    mocks.exec.mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 });
    mocks.setOutboundHandler.mockImplementation(async (method: string) => {
      if (method === "locked") {
        throw new Error("locked rpc down");
      }
    });
    await expect(
      instance.execWithEgress("pnpm install", { egress: { profile: "install" } }),
    ).rejects.toThrow("locked rpc down");
    expect(errorSpy).toHaveBeenCalled();

    mocks.destroy.mockClear();
    await instance.destroyGuarded("sandbox-poisoned");
    expect(mocks.destroy).toHaveBeenCalledTimes(1);
  });

  it("checkout 実行中に destroyGuarded が割り込んだ場合は #destroyEpoch 変化を検知して中断し、locked へ復帰する", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const { instance, mocks, waitForInit } = createReviewSandbox();
    await waitForInit();
    mocks.setOutboundHandler.mockClear();

    let releaseExec!: () => void;
    const execGate = new Promise<void>((resolve) => {
      releaseExec = resolve;
    });
    mocks.exec.mockImplementationOnce(async () => {
      await execGate;
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    const checkoutPromise = instance.execWithEgress("git fetch", {
      egress: { profile: "checkout", repository: "octo/repo", githubToken: "ghs_race" },
    });
    await vi.waitFor(() => expect(mocks.exec).toHaveBeenCalledTimes(1));

    await instance.destroyGuarded("sandbox-race");
    releaseExec();

    await expect(checkoutPromise).rejects.toThrow("sandbox was destroyed during checkout phase");
    expect(mocks.setOutboundHandler.mock.calls.at(-1)?.[0]).toBe("locked");
  });

  it("ゲート待機中の exclusive / locked 操作は destroyGuarded 後にコンテナを再起動・egress 再開放せず中断する", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const { instance, mocks, waitForInit } = createReviewSandbox();
    await waitForInit();
    mocks.setOutboundHandler.mockClear();

    let releaseFirstExec!: () => void;
    const firstExecGate = new Promise<void>((resolve) => {
      releaseFirstExec = resolve;
    });
    mocks.exec.mockImplementationOnce(async () => {
      await firstExecGate;
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    const firstInstall = instance.execWithEgress("pnpm install", {
      egress: { profile: "install" },
    });
    await vi.waitFor(() => expect(mocks.exec).toHaveBeenCalledTimes(1));

    // 先行 install 実行中に、後続の checkout / locked exec / readFile / writeFile / listFiles をキューへ積む
    const queuedCheckout = instance.execWithEgress("git fetch", {
      egress: { profile: "checkout", repository: "octo/repo", githubToken: "ghs_queued" },
    });
    const queuedLockedExec = instance.execWithEgress("echo revive");
    const queuedRead = instance.readFileGuarded("src/index.ts");
    const queuedWrite = instance.writeFileGuarded("tmp.txt", "x");
    const queuedList = instance.listFilesGuarded(".");
    await Promise.resolve();

    // 待機中に destroyGuarded() が走る
    await instance.destroyGuarded("sandbox-queued-destroy");
    releaseFirstExec();

    await expect(firstInstall).rejects.toThrow("sandbox was destroyed during install phase");
    await expect(queuedCheckout).rejects.toThrow("sandbox was destroyed during checkout phase");
    await expect(queuedLockedExec).rejects.toThrow("sandbox was destroyed during locked phase");
    await expect(queuedRead).rejects.toThrow("sandbox was destroyed during locked phase");
    await expect(queuedWrite).rejects.toThrow("sandbox was destroyed during locked phase");
    await expect(queuedList).rejects.toThrow("sandbox was destroyed during locked phase");

    // 待機していた操作はいずれも実行されず、checkout egress も再適用されない
    expect(mocks.exec).toHaveBeenCalledTimes(1);
    expect(mocks.readFile).not.toHaveBeenCalled();
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(mocks.listFiles).not.toHaveBeenCalled();
    expect(mocks.setOutboundHandler.mock.calls.some(([method]) => method === "checkout")).toBe(
      false,
    );
  });

  it("resetContainer: true の checkout はコールドスタート予算を含めた egress TTL を設定する", async () => {
    const { instance, mocks, waitForInit } = createReviewSandbox();
    await waitForInit();
    mocks.setOutboundHandler.mockClear();
    mocks.exec.mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 });

    const before = Date.now();
    await instance.execWithEgress("git fetch", {
      egress: {
        profile: "checkout",
        repository: "octo/repo",
        githubToken: "ghs_coldstart",
        resetContainer: true,
      },
    });

    const checkoutParams = mocks.setOutboundHandler.mock.calls.find(
      ([method]) => method === "checkout",
    )?.[1] as { expiresAt: number };
    // CHECKOUT_EXEC_DEFAULT_TIMEOUT_MS (120s) + CONTAINER_STARTUP_BUFFER_MS (120s) + grace (5s) = 245s
    expect(checkoutParams.expiresAt - before).toBeGreaterThanOrEqual(240_000);
  });
});

describe("SandboxEntrypoint", () => {
  const namespace = {} as Env["Sandbox"];
  const entrypoint = new SandboxEntrypoint({} as ExecutionContext, { Sandbox: namespace });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writeFile / readFile / listFiles / exec / destroy を ReviewSandbox のガード付きメソッドへ委譲する", async () => {
    sandboxStub.writeFileGuarded.mockResolvedValue(undefined);
    sandboxStub.readFileGuarded.mockResolvedValue("hello");
    sandboxStub.listFilesGuarded.mockResolvedValue(["repro.txt", "README.md"]);
    sandboxStub.execWithEgress.mockResolvedValue({
      stdout: "hello\n",
      stderr: "",
      exitCode: 0,
    });
    sandboxStub.destroyGuarded.mockResolvedValue(undefined);

    await entrypoint.writeFile("sandbox-1", "repro.txt", "hello");
    const content = await entrypoint.readFile("sandbox-1", "repro.txt");
    const files = await entrypoint.listFiles("sandbox-1", ".");
    const execResult = await entrypoint.exec("sandbox-1", "cat repro.txt", {
      egress: { profile: "install" },
      timeoutMs: 30_000,
    });
    await entrypoint.destroy("sandbox-1");

    expect(content).toBe("hello");
    expect(files).toEqual(["repro.txt", "README.md"]);
    expect(execResult).toEqual({ stdout: "hello\n", stderr: "", exitCode: 0 });
    expect(sandboxStub.execWithEgress).toHaveBeenCalledWith(
      "cat repro.txt",
      { egress: { profile: "install" }, timeoutMs: 30_000 },
      "sandbox-1",
    );
    expect(sandboxStub.destroyGuarded).toHaveBeenCalledWith("sandbox-1");
  });

  it("64 文字の DurableObjectId を @cloudflare/sandbox の上限である 63 文字に切り詰めて渡す", async () => {
    sandboxStub.listFilesGuarded.mockResolvedValue([]);
    sandboxStub.destroyGuarded.mockResolvedValue(undefined);
    const durableObjectId = "a".repeat(64);

    await entrypoint.listFiles(durableObjectId, ".");
    await entrypoint.destroy(durableObjectId);

    expect(getSandboxMock).toHaveBeenCalledWith(namespace, "a".repeat(63), {
      normalizeId: true,
    });
    expect(sandboxStub.destroyGuarded).toHaveBeenCalledWith(durableObjectId);
  });
});

describe("Dockerfile", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const dockerfile = readFileSync(resolve(here, "../Dockerfile"), "utf8");
  const sandboxPkg = JSON.parse(
    readFileSync(resolve(here, "../node_modules/@cloudflare/sandbox/package.json"), "utf8"),
  ) as { version: string };
  const rootPkg = JSON.parse(readFileSync(resolve(here, "../../../package.json"), "utf8")) as {
    packageManager: string;
  };

  it("ベースイメージのタグが @cloudflare/sandbox のバージョンと一致する", () => {
    expect(dockerfile).toContain(`FROM docker.io/cloudflare/sandbox:${sandboxPkg.version}`);
  });

  it("npm に加えて corepack / pnpm / yarn をグローバルインストールし、npm の自動 audit/fund を無効化する", () => {
    expect(dockerfile).toContain("COREPACK_ENABLE_DOWNLOAD_PROMPT=0");
    expect(dockerfile).toContain("NPM_CONFIG_AUDIT=false");
    expect(dockerfile).toContain("NPM_CONFIG_FUND=false");
    expect(dockerfile).toContain(rootPkg.packageManager);
    expect(dockerfile).toMatch(/RUN\s+npm\s+install\s+-g\b.*\bcorepack@[\d.]+/);
    expect(dockerfile).toMatch(/RUN\s+npm\s+install\s+-g\b.*\bpnpm@[\d.]+/);
    expect(dockerfile).toMatch(/RUN\s+npm\s+install\s+-g\b.*\byarn@[\d.]+/);
  });
});
