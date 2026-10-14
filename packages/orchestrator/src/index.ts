import { DurableObject } from "cloudflare:workers";

/**
 * PR 単位のレビューループを制御する素の Durable Object。
 * イテレーション間の待機は alarm() で行う。
 */
export class ReviewOrchestrator extends DurableObject {
  /** gateway からレビュー開始要求を受け取る。TODO: 実装。 */
  async start(_pullRequestId: string): Promise<void> {
    throw new Error("not implemented: ReviewOrchestrator.start");
  }

  /** 次イテレーションの起動点。TODO: 実装。 */
  override async alarm(): Promise<void> {
    throw new Error("not implemented: ReviewOrchestrator.alarm");
  }
}
