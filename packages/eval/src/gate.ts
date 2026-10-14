import type { Severity } from "@repo/review-core";

/** 深刻度の比較順序。ゲートのしきい値判定に使う。 */
export const SEVERITY_ORDER: readonly Severity[] = ["blocker", "major", "minor", "nit"];

export interface GateResult {
  readonly passed: boolean;
  readonly regressions: readonly string[];
}

/**
 * 保存済みのゴールデン PR を replay し、期待する指摘との差分を取る。
 * TODO: 実装。
 */
export function replayGate(_fixtureDir: string): Promise<GateResult> {
  throw new Error("not implemented: replayGate");
}
