import type { GitHubPort } from "../ports.js";

/**
 * getDiff / postReview / resolveThread をモデル向けツールとして露出する。
 * TODO: 実装。
 */
export function createGitHubTools(_github: GitHubPort): Record<string, unknown> {
  throw new Error("not implemented: createGitHubTools");
}
