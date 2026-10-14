/** モデルに渡すコンテキストと、そのトークン予算。 */
export interface ContextBudget {
  readonly maxInputTokens: number;
  readonly reserveForOutput: number;
}

export interface AssembledContext {
  readonly messages: readonly { role: "system" | "user" | "assistant"; content: string }[];
  readonly estimatedTokens: number;
}

/**
 * 差分・過去の指摘・ツール結果からプロンプトを組み立て、予算内に収める。
 * TODO: 実装。
 */
export function assembleContext(_budget: ContextBudget): AssembledContext {
  throw new Error("not implemented: assembleContext");
}
