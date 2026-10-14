import type { ReviewRun, Verdict } from "./schema.js";

/** 収束判定のパラメータ。 */
export interface ConvergenceOptions {
  readonly maxIterations: number;
}

/**
 * 直近のレビュー履歴から、ループを継続すべきかを判定する。
 * TODO: 実装。
 */
export function evaluateConvergence(
  _runs: readonly ReviewRun[],
  _options: ConvergenceOptions,
): Verdict {
  throw new Error("not implemented: evaluateConvergence");
}

/**
 * 同じ指摘が消えては再出現する「振動」を検知する。
 * TODO: 実装。
 */
export function detectOscillation(_runs: readonly ReviewRun[]): boolean {
  throw new Error("not implemented: detectOscillation");
}
