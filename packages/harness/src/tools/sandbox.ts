import type { SandboxPort } from "../ports.js";

/**
 * fs / shell 操作をモデル向けツールとして露出する。
 * TODO: 実装。
 */
export function createSandboxTools(_sandbox: SandboxPort): Record<string, unknown> {
  throw new Error("not implemented: createSandboxTools");
}
