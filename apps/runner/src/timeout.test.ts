import { describe, expect, it } from "vitest";

import {
  CHECKOUT_EXEC_DEFAULT_TIMEOUT_MS,
  CONTAINER_STARTUP_BUFFER_MS,
  computeOuterTimeoutMs,
  extractTimedOutResult,
  INSTALL_EXEC_DEFAULT_TIMEOUT_MS,
  INSTALL_EXEC_MAX_TIMEOUT_MS,
  LOCKED_EXEC_DEFAULT_TIMEOUT_MS,
  LOCKED_EXEC_MAX_TIMEOUT_MS,
  MIN_EXEC_TIMEOUT_MS,
  resolveExecTimeoutMs,
  SDK_TIMEOUT_BUFFER_MS,
  TIMEOUT_KILL_GRACE_SECONDS,
  timeoutMarker,
  wrapCommandWithTimeout,
} from "./timeout.js";

describe("resolveExecTimeoutMs", () => {
  it("省略時はプロファイルごとの既定タイムアウトを返す", () => {
    expect(resolveExecTimeoutMs("locked")).toBe(LOCKED_EXEC_DEFAULT_TIMEOUT_MS);
    expect(resolveExecTimeoutMs("checkout")).toBe(CHECKOUT_EXEC_DEFAULT_TIMEOUT_MS);
    expect(resolveExecTimeoutMs("install")).toBe(INSTALL_EXEC_DEFAULT_TIMEOUT_MS);
  });

  it("正の有限数はプロファイルの下限・上限にクランプして切り上げる", () => {
    expect(resolveExecTimeoutMs("locked", 200)).toBe(MIN_EXEC_TIMEOUT_MS);
    expect(resolveExecTimeoutMs("locked", 15_000.2)).toBe(15_001);
    expect(resolveExecTimeoutMs("locked", 999_999)).toBe(LOCKED_EXEC_MAX_TIMEOUT_MS);
    expect(resolveExecTimeoutMs("checkout", 999_999)).toBe(CHECKOUT_EXEC_DEFAULT_TIMEOUT_MS);
    expect(resolveExecTimeoutMs("install", 420_000)).toBe(420_000);
    expect(resolveExecTimeoutMs("install", 999_999)).toBe(INSTALL_EXEC_MAX_TIMEOUT_MS);
  });

  it.each([Number.NaN, 0, -1, -1_000, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "不正な timeoutMs (%s) は fail-open を防ぐため RangeError で拒否する",
    (invalid) => {
      expect(() => resolveExecTimeoutMs("locked", invalid)).toThrow(RangeError);
    },
  );
});

describe("computeOuterTimeoutMs", () => {
  it("コールドスタート予算・SIGKILL 猶予・SDK 余裕を上乗せする", () => {
    expect(computeOuterTimeoutMs(60_000)).toBe(
      60_000 +
        CONTAINER_STARTUP_BUFFER_MS +
        TIMEOUT_KILL_GRACE_SECONDS * 1_000 +
        SDK_TIMEOUT_BUFFER_MS,
    );
  });
});

describe("wrapCommandWithTimeout", () => {
  it("デフォルトシェルを終了しないサブシェルと GNU timeout --kill-after=5s でラップし、シングルクォートを安全にエスケープする", () => {
    const wrapped = wrapCommandWithTimeout("echo 'hello world' && exit 0", 45_000, "nonce-1");

    expect(wrapped.startsWith("( ")).toBe(true);
    expect(wrapped.endsWith(" )")).toBe(true);
    expect(wrapped).toContain(
      "timeout --kill-after=5s 45s bash -c 'echo '\\''hello world'\\'' && exit 0'",
    );
    expect(wrapped).toContain(`'${timeoutMarker("nonce-1")}'`);
    expect(wrapped).toContain("-ge 44750");
  });

  it("小数秒のタイムアウトも余分な末尾ゼロなしでフォーマットする", () => {
    const wrapped = wrapCommandWithTimeout("sleep 10", 1_500, "nonce-2");
    expect(wrapped).toContain("timeout --kill-after=5s 1.5s bash -c 'sleep 10'");
  });
});

describe("extractTimedOutResult", () => {
  it("マーカーが無ければ timedOut プロパティを付与せず結果をそのまま返す（自発的な exit 124 を含む）", () => {
    const normal = extractTimedOutResult(
      { stdout: "ok", stderr: "", exitCode: 0 },
      "nonce-a",
      60_000,
    );
    expect(normal).toEqual({ stdout: "ok", stderr: "", exitCode: 0 });
    expect("timedOut" in normal).toBe(false);

    const voluntary124 = extractTimedOutResult(
      { stdout: "", stderr: "custom exit 124", exitCode: 124 },
      "nonce-a",
      60_000,
    );
    expect(voluntary124).toEqual({ stdout: "", stderr: "custom exit 124", exitCode: 124 });
    expect("timedOut" in voluntary124).toBe(false);
  });

  it("末尾のタイムアウトマーカーを検出して除去し、timedOut: true とタイムアウト通知を返す", () => {
    const marker = timeoutMarker("nonce-b");
    const withStderr = extractTimedOutResult(
      { stdout: "partial out", stderr: `warning line\n${marker}\n`, exitCode: 124 },
      "nonce-b",
      30_000,
    );
    expect(withStderr).toEqual({
      stdout: "partial out",
      stderr: "warning line\ncommand timed out after 30000ms",
      exitCode: 124,
      timedOut: true,
    });

    const emptyStderr = extractTimedOutResult(
      { stdout: "", stderr: `\n${marker}\n`, exitCode: 124 },
      "nonce-b",
      30_000,
    );
    expect(emptyStderr).toEqual({
      stdout: "",
      stderr: "command timed out after 30000ms",
      exitCode: 124,
      timedOut: true,
    });
  });

  it("別 nonce のマーカーが stderr に含まれても偽装タイムアウトとして扱わない", () => {
    const forged = extractTimedOutResult(
      { stdout: "", stderr: `\n${timeoutMarker("other-nonce")}\n`, exitCode: 124 },
      "real-nonce",
      30_000,
    );
    expect(forged.timedOut).toBeUndefined();
  });

  it("マーカー出力後に孤立子プロセスが stderr へ追記した場合でもタイムアウトを検出しマーカー行を除去する", () => {
    const marker = timeoutMarker("nonce-orphan");
    const result = extractTimedOutResult(
      {
        stdout: "",
        stderr: `before\n${marker}\nlate orphan output\n`,
        exitCode: 124,
      },
      "nonce-orphan",
      10_000,
    );
    expect(result).toEqual({
      stdout: "",
      stderr: "before\nlate orphan output\ncommand timed out after 10000ms",
      exitCode: 124,
      timedOut: true,
    });
  });
});
