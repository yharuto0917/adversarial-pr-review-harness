import { defineExtension, type Extension, section } from "@earendil-works/pi-durable";

import type { HarnessPorts } from "../ports.js";
import { createFindingTools } from "./findings.js";
import { createGitHubTools } from "./github.js";
import { createSandboxTools } from "./sandbox.js";

export const REVIEW_EXTENSION_NAME = "pr-review";

const PREAMBLE = `あなたは Pull Request を敵対的にレビューするレビュアーです。
作者の説明を鵜呑みにせず、変更が壊しうる箇所を自分で探して確かめてください。

進め方:
1. get_diff で差分を取得し、変更の意図と影響範囲を把握する。
2. 疑わしい箇所は read_file / list_files で周辺コードを読み、exec でテストや再現手順を実行して裏付けを取る。
3. 裏付けが取れた問題だけを report_finding で 1 件ずつ報告する。
4. すべて報告し終えたら、post_review で総評を 1 度だけ投稿する。

裏付けのない推測は報告しないでください。問題が見つからなければ、その旨を総評に書いて終えてください。`;

/** レビュー用のツールとシステムプロンプトを、Pi の拡張 1 つにまとめる。 */
export function createReviewExtension(ports: HarnessPorts): Extension {
  return defineExtension({
    name: REVIEW_EXTENSION_NAME,
    sections: [section("preamble", () => PREAMBLE, { tag: false })],
    tools: [
      ...createGitHubTools(ports.github),
      ...createSandboxTools(ports.sandbox),
      ...createFindingTools(ports.findings),
    ],
  });
}
