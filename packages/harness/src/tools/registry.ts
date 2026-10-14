import type { HarnessPorts } from "../ports.js";

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
}

/**
 * 全ツールのスキーマを登録し、名前からディスパッチできるようにする。
 * TODO: 実装。
 */
export function createToolRegistry(_ports: HarnessPorts): Map<string, ToolDefinition> {
  throw new Error("not implemented: createToolRegistry");
}
