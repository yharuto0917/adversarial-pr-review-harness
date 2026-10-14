import type { SandboxPort } from "./ports.js";

export interface VerificationResult {
  readonly passed: boolean;
  readonly evidence: readonly string[];
}

/**
 * モデルの「完了しました」という宣言を、サンドボックス上の客観的な事実で検証する。
 * TODO: 実装。
 */
export function verifyCompletionClaim(
  _sandbox: SandboxPort,
  _claim: string,
): Promise<VerificationResult> {
  throw new Error("not implemented: verifyCompletionClaim");
}
