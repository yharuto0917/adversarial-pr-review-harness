export interface TruncateOptions {
  readonly maxChars: number;
}

/**
 * ツール結果を切り詰め、省略した旨を明示した文字列に整形する。
 * TODO: 実装。
 */
export function truncateToolResult(_value: string, _options: TruncateOptions): string {
  throw new Error("not implemented: truncateToolResult");
}
