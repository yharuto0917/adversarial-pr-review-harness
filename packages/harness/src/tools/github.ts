import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";

import type { GitHubPort } from "../ports.js";
import { text } from "./result.js";

const DIFF_OUTPUT_LIMITS = { maxBytes: 128_000, maxLines: 4_000, retain: "head" } as const;

/**
 * Read 専用の GitHub 操作だけをモデル向けツールとして露出する。
 * Write 系（`postReview` / `resolveThread`）は Orchestrator 専用のためここには含めない。
 * また他ブランチ覗き見を防ぐため `get_diff` からは任意の `range` 引数を露出しない。
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

  return [getDiff] as ToolRegistration[];
}
