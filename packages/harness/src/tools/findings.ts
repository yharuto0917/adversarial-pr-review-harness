import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";

import type { FindingsPort } from "../ports.js";
import { text } from "./result.js";

const Finding = Type.Object({
  path: Type.String({ minLength: 1, description: "リポジトリルートからの相対パス" }),
  line: Type.Optional(
    Type.Integer({ minimum: 1, description: "指摘箇所の行番号。ファイル全体への指摘なら省略する" }),
  ),
  severity: Type.Union([
    Type.Literal("blocker"),
    Type.Literal("major"),
    Type.Literal("minor"),
    Type.Literal("nit"),
  ]),
  title: Type.String({ minLength: 1 }),
  body: Type.String(),
});

/**
 * 指摘を 1 件ずつ構造化データとして受け取る。
 * 最終回答のテキストを解析して指摘を拾うのではなく、ここを通ったものだけを指摘として扱う。
 */
export function createFindingTools(findings: FindingsPort): ToolRegistration[] {
  const reportFinding = defineTool({
    name: "report_finding",
    description:
      "確認できた問題を 1 件報告する。推測ではなく、差分やコマンドの実行結果で裏付けが取れたものだけを報告する。",
    parameters: Finding,
    // FindingsPort が同一内容の再報告を無視する前提
    replay: "safe",
    async execute({ path, line, severity, title, body }) {
      await findings.report({ path, line: line ?? null, severity, title, body });
      return text(`recorded: [${severity}] ${title}`);
    },
  });

  return [reportFinding] as ToolRegistration[];
}
