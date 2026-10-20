import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";

import type { GitHubPort } from "../ports.js";
import { text } from "./result.js";

const DIFF_OUTPUT_LIMITS = { maxBytes: 128_000, maxLines: 4_000, retain: "head" } as const;

/**
 * getDiff / postReview / resolveThread をモデル向けツールとして露出する。
 * GitHub に書き込む 2 つは二重投稿を避けるため、中断後に再実行させない（`replay` 既定）。
 */
export function createGitHubTools(github: GitHubPort): ToolRegistration[] {
  const getDiff = defineTool({
    name: "get_diff",
    description: "レビュー対象の Pull Request の差分を unified diff 形式で取得する。",
    parameters: Type.Object({}),
    replay: "safe",
    outputLimits: DIFF_OUTPUT_LIMITS,
    async execute() {
      return text(await github.getDiff());
    },
  });

  const postReview = defineTool({
    name: "post_review",
    description:
      "レビュー全体の総評を Pull Request に投稿する。指摘の報告がすべて済んでから 1 度だけ呼ぶ。",
    parameters: Type.Object({ body: Type.String({ minLength: 1 }) }),
    async execute({ body }) {
      await github.postReview(body);
      return text("posted");
    },
  });

  const resolveThread = defineTool({
    name: "resolve_thread",
    description: "修正済みと確認できたレビュースレッドを解決済みにする。",
    parameters: Type.Object({ threadId: Type.String({ minLength: 1 }) }),
    async execute({ threadId }) {
      await github.resolveThread(threadId);
      return text(`resolved ${threadId}`);
    },
  });

  return [getDiff, postReview, resolveThread] as ToolRegistration[];
}
