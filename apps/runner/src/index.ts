import { Sandbox } from "@cloudflare/sandbox";

/**
 * レビュー実行用の Sandbox サブクラス。
 * Container を持つ Durable Object なので、Worker エントリから re-export する。
 *
 * TODO: 外向き通信を監査するため HTTPS インターセプトを有効化する
 *       (@cloudflare/sandbox 0.12.9 の公開型には該当 API が無いため、
 *        採用するバージョンで API を確認してから実装する)
 */
export class ReviewSandbox extends Sandbox {}

export default {
  async fetch(): Promise<Response> {
    // TODO: gateway からの service binding 経由でレビュー実行を受け付ける
    return new Response(JSON.stringify({ ok: false, reason: "not implemented" }), {
      status: 501,
      headers: { "content-type": "application/json" },
    });
  },
} satisfies ExportedHandler<Env>;
