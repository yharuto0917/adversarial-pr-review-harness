/** テキスト 1 件だけのツール結果を組み立てる。 */
export function text(value: string) {
  return { output: [{ type: "text" as const, text: value }] };
}
