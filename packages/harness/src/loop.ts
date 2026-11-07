import type { ReviewRun } from "@repo/review-core";

import type { HarnessPorts } from "./ports.js";

export interface LoopOptions {
  readonly maxIterations: number;
  readonly modelId: string;
}

/**
 * レビューの 1 サイクル（コンテキスト組み立て → ツール実行 → 完了検証）を回す。
 * TODO: 実装。
 */
export function runReviewLoop(_ports: HarnessPorts, _options: LoopOptions): Promise<ReviewRun> {
  throw new Error("not implemented: runReviewLoop");
}
