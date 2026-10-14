import type { Finding } from "./schema.js";

/**
 * 指摘内容から世代をまたいで安定する fingerprint を計算する。
 * TODO: 実装。
 */
export function computeFingerprint(_finding: Omit<Finding, "fingerprint">): string {
  throw new Error("not implemented: computeFingerprint");
}

/**
 * fingerprint が同一の指摘を畳み込む。
 * TODO: 実装。
 */
export function dedupeFindings(_findings: readonly Finding[]): Finding[] {
  throw new Error("not implemented: dedupeFindings");
}
