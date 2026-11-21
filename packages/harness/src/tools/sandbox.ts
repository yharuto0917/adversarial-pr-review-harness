import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";

import type { SandboxPort } from "../ports.js";
import { text } from "./result.js";

/** コマンド出力がコンテキストを食い潰さないための上限。超過分は Pi が切り詰める。 */
const EXEC_OUTPUT_LIMITS = { maxBytes: 32_000, maxLines: 400, retain: "tail" } as const;
const READ_OUTPUT_LIMITS = { maxBytes: 64_000, maxLines: 1_500, retain: "head" } as const;
const MIN_TOOL_EXEC_TIMEOUT_SECONDS = 1;
const MAX_TOOL_EXEC_TIMEOUT_SECONDS = 120;

/**
 * fs / shell 操作をモデル向けツールとして露出する。
 * `replay` は中断後に再実行してよいかの宣言で、副作用が読めない `exec` だけ既定（再実行しない）のままにする。
 */
export function createSandboxTools(sandbox: SandboxPort): ToolRegistration[] {
  const exec = defineTool({
    name: "exec",
    description:
      "サンドボックス内でシェルコマンドを実行する。テストの実行や再現手順の確認に使う。終了コードと標準出力・標準エラーを返す。既定 60 秒（最大 120 秒）を超えると強制終了される。",
    parameters: Type.Object({
      command: Type.String({ minLength: 1 }),
      timeoutSeconds: Type.Optional(
        Type.Integer({
          minimum: MIN_TOOL_EXEC_TIMEOUT_SECONDS,
          maximum: MAX_TOOL_EXEC_TIMEOUT_SECONDS,
          description: "コマンド実行の上限時間（秒）。省略時は既定 60 秒、上限は 120 秒。",
        }),
      ),
    }),
    outputLimits: EXEC_OUTPUT_LIMITS,
    async execute({ command, timeoutSeconds }) {
      const result =
        timeoutSeconds === undefined
          ? await sandbox.exec(command)
          : await sandbox.exec(command, { timeoutMs: timeoutSeconds * 1_000 });
      const header = result.timedOut
        ? `exit code: ${result.exitCode} (timed out)`
        : `exit code: ${result.exitCode}`;
      const sections = [header];
      if (result.stdout) sections.push(`--- stdout ---\n${result.stdout}`);
      if (result.stderr) sections.push(`--- stderr ---\n${result.stderr}`);
      return {
        ...text(sections.join("\n")),
        isError: result.timedOut === true || result.exitCode !== 0,
      };
    },
  });

  const readFile = defineTool({
    name: "read_file",
    description: "サンドボックス内のファイルをテキストとして読む。",
    parameters: Type.Object({ path: Type.String({ minLength: 1 }) }),
    replay: "safe",
    outputLimits: READ_OUTPUT_LIMITS,
    async execute({ path }) {
      return text(await sandbox.readFile(path));
    },
  });

  const writeFile = defineTool({
    name: "write_file",
    description:
      "サンドボックス内のファイルを丸ごと書き換える。指摘を裏付ける再現テストを置くために使う。",
    parameters: Type.Object({ path: Type.String({ minLength: 1 }), content: Type.String() }),
    // 全体を上書きするので、二度実行しても結果は変わらない
    replay: "safe",
    async execute({ path, content }) {
      await sandbox.writeFile(path, content);
      return text(`wrote ${path}`);
    },
  });

  const listFiles = defineTool({
    name: "list_files",
    description: "サンドボックス内のディレクトリ直下にあるファイルを列挙する。",
    parameters: Type.Object({ path: Type.String({ minLength: 1 }) }),
    replay: "safe",
    outputLimits: READ_OUTPUT_LIMITS,
    async execute({ path }) {
      const files = await sandbox.listFiles(path);
      return text(files.length > 0 ? files.join("\n") : "(empty)");
    },
  });

  return [exec, readFile, writeFile, listFiles] as ToolRegistration[];
}
