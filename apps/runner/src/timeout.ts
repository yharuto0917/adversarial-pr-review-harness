import type { ExecResult } from "@repo/harness";

import { CHECKOUT_EGRESS_TTL_MS, type EgressPhase, INSTALL_EGRESS_TTL_MS } from "./egress.js";

/** コマンド実行時間の下限（1 秒）。 */
export const MIN_EXEC_TIMEOUT_MS = 1_000;

/** 通常（locked）コマンドの既定タイムアウト（60 秒）。 */
export const LOCKED_EXEC_DEFAULT_TIMEOUT_MS = 60_000;

/** 通常（locked）コマンドの上限タイムアウト（120 秒）。 */
export const LOCKED_EXEC_MAX_TIMEOUT_MS = 120_000;

/** checkout コマンドの既定・上限タイムアウト（2 分、CHECKOUT_EGRESS_TTL_MS と整合）。 */
export const CHECKOUT_EXEC_DEFAULT_TIMEOUT_MS = CHECKOUT_EGRESS_TTL_MS;
export const CHECKOUT_EXEC_MAX_TIMEOUT_MS = CHECKOUT_EGRESS_TTL_MS;

/** install コマンドの既定タイムアウト（5 分）・上限（10 分、INSTALL_EGRESS_TTL_MS と整合）。 */
export const INSTALL_EXEC_DEFAULT_TIMEOUT_MS = 5 * 60 * 1_000;
export const INSTALL_EXEC_MAX_TIMEOUT_MS = INSTALL_EGRESS_TTL_MS;

/** GNU timeout が SIGTERM から SIGKILL へ昇格するまでの猶予時間（5 秒）。 */
export const TIMEOUT_KILL_GRACE_SECONDS = 5;

/** SDK 側ハードタイムアウトへ上乗せするコンテナ起動予算（120 秒）と通信余裕（15 秒）。 */
export const CONTAINER_STARTUP_BUFFER_MS = 120_000;
export const SDK_TIMEOUT_BUFFER_MS = 15_000;

/** 経過時間判定のクロック誤差マージン（250 ms）。 */
const MIN_ELAPSED_MARGIN_MS = 250;

const TIMEOUT_EXIT_CODE = 124;

const PHASE_TIMEOUT_BOUNDS: Readonly<
  Record<EgressPhase, { readonly defaultMs: number; readonly maxMs: number }>
> = {
  locked: {
    defaultMs: LOCKED_EXEC_DEFAULT_TIMEOUT_MS,
    maxMs: LOCKED_EXEC_MAX_TIMEOUT_MS,
  },
  checkout: {
    defaultMs: CHECKOUT_EXEC_DEFAULT_TIMEOUT_MS,
    maxMs: CHECKOUT_EXEC_MAX_TIMEOUT_MS,
  },
  install: {
    defaultMs: INSTALL_EXEC_DEFAULT_TIMEOUT_MS,
    maxMs: INSTALL_EXEC_MAX_TIMEOUT_MS,
  },
};

/**
 * 実行フェーズごとのタイムアウト（ミリ秒）を解決する。
 * 不正値（NaN / 0 以下 / Infinity）は fail-open を防ぐため例外で拒否し、
 * 有効な正の有限数は `[MIN_EXEC_TIMEOUT_MS, phaseMax]` にクランプする。
 */
export function resolveExecTimeoutMs(phase: EgressPhase, requestedTimeoutMs?: number): number {
  const bounds = PHASE_TIMEOUT_BOUNDS[phase];
  if (requestedTimeoutMs === undefined) {
    return bounds.defaultMs;
  }
  if (
    typeof requestedTimeoutMs !== "number" ||
    !Number.isFinite(requestedTimeoutMs) ||
    requestedTimeoutMs <= 0
  ) {
    throw new RangeError(`invalid exec timeoutMs: ${String(requestedTimeoutMs)}`);
  }
  const rounded = Math.ceil(requestedTimeoutMs);
  return Math.min(Math.max(rounded, MIN_EXEC_TIMEOUT_MS), bounds.maxMs);
}

/**
 * 第 2 層（SDK 側）のハードタイムアウトを算出する。
 * コンテナのコールドスタート中に誤発動しないよう起動予算と SIGKILL 猶予を上乗せする。
 */
export function computeOuterTimeoutMs(timeoutMs: number): number {
  return (
    timeoutMs +
    CONTAINER_STARTUP_BUFFER_MS +
    TIMEOUT_KILL_GRACE_SECONDS * 1_000 +
    SDK_TIMEOUT_BUFFER_MS
  );
}

/** タイムアウト検出用の実行単位マーカー文字列。 */
export function timeoutMarker(nonce: string): string {
  return `__SANDBOX_TIMEOUT_${nonce}__`;
}

/**
 * 任意コマンドを GNU coreutils `timeout` とコンテナ内経過時間判定でラップする。
 *
 * - デフォルトシェルセッション自体を終了させないためサブシェル `( ... )` で包む。
 * - `timeout --kill-after=5s` は独立プロセスグループに SIGTERM → SIGKILL を送るため、
 *   テストランナー等の子プロセスも残留させずに打ち切れる。
 * - 経過時間はコンテナ起動後の実行直前から計測するため、コールドスタート時間は混入せず、
 *   コマンド自発の `exit 124` や即時の OOM (`exit 137`) をタイムアウトと誤認しない。
 */
export function wrapCommandWithTimeout(command: string, timeoutMs: number, nonce: string): string {
  const timeoutSec = formatTimeoutSeconds(timeoutMs);
  const minElapsedMs = Math.max(0, timeoutMs - MIN_ELAPSED_MARGIN_MS);
  const marker = timeoutMarker(nonce);
  const escapedCommand = shellQuoteSingle(command);

  return [
    "( __s=$(date +%s%3N)",
    `timeout --kill-after=${TIMEOUT_KILL_GRACE_SECONDS}s ${timeoutSec}s bash -c ${escapedCommand}`,
    "__rc=$?",
    "__e=$(( $(date +%s%3N) - __s ))",
    `if { [ "$__rc" -eq 124 ] || [ "$__rc" -eq 137 ]; } && [ "$__e" -ge ${minElapsedMs} ]; then printf '\\n%s\\n' ${shellQuoteSingle(marker)} >&2; exit ${TIMEOUT_EXIT_CODE}; fi`,
    'exit "$__rc" )',
  ].join("; ");
}

/**
 * `wrapCommandWithTimeout` 実行結果からタイムアウトマーカーを検出・除去し、
 * `ExecResult` に正規化する。通常終了時は `timedOut` プロパティを付与しない。
 */
export function extractTimedOutResult(
  raw: { readonly stdout: string; readonly stderr: string; readonly exitCode: number },
  nonce: string,
  timeoutMs: number,
): ExecResult {
  const marker = timeoutMarker(nonce);
  const stripped = stripTrailingMarker(raw.stderr, marker);
  if (stripped === null) {
    return {
      stdout: raw.stdout,
      stderr: raw.stderr,
      exitCode: raw.exitCode,
    };
  }

  const notice = `command timed out after ${timeoutMs}ms`;
  const trimmed = stripped.trimEnd();
  const stderr = trimmed.length > 0 ? `${trimmed}\n${notice}` : notice;
  return {
    stdout: raw.stdout,
    stderr,
    exitCode: TIMEOUT_EXIT_CODE,
    timedOut: true,
  };
}

function formatTimeoutSeconds(timeoutMs: number): string {
  return (timeoutMs / 1_000).toFixed(3).replace(/\.?0+$/, "");
}

function shellQuoteSingle(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function stripTrailingMarker(stderr: string, marker: string): string | null {
  const candidates = [`\n${marker}\n`, `\n${marker}`, `${marker}\n`, marker];
  for (const suffix of candidates) {
    if (stderr.endsWith(suffix)) {
      return stderr.slice(0, stderr.length - suffix.length);
    }
  }
  // 孤立子プロセスがマーカー出力後に stderr へ追記した場合でも、
  // 実行ごとの UUID nonce と一致する独立行があればタイムアウトとして検出・除去する
  const lines = stderr.split("\n");
  const markerIndex = lines.lastIndexOf(marker);
  if (markerIndex !== -1) {
    const remaining = [...lines.slice(0, markerIndex), ...lines.slice(markerIndex + 1)];
    return remaining.join("\n");
  }
  return null;
}
