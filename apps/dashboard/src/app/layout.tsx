import type { ReactNode } from "react";

export const metadata = {
  title: "PR Review Harness",
  description: "レビュー実行の履歴・メトリクス・承認",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
