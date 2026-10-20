import { DurableObject } from "cloudflare:workers";
import type { ApiKeyCredential, MutableModels, OAuthCredential } from "@earendil-works/pi-ai";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";

import { SqlCredentialStore } from "./credential-store.js";
import { OAUTH_PROVIDERS } from "./vault-credentials.js";

/** 単一インスタンスで運用するための固定名。 */
export const VAULT_INSTANCE_NAME = "default";

export type ImportResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export interface VaultStatus {
  readonly providerId: string;
  /** アクセストークンの期限（ミリ秒）。期限切れでも、次回の解決時に更新される。 */
  readonly expires: number;
}

/**
 * Sign in with ChatGPT の認証情報を 1 か所で保持し、更新する Durable Object。
 *
 * リフレッシュトークンは更新のたびにローテーションされるので、PR ごとの Durable Object が
 * それぞれコピーを持つと互いに失効させてしまう。ここだけがリフレッシュトークンを持ち、
 * 他には有効なアクセストークンだけを渡す。
 */
export class CredentialVault extends DurableObject<object> {
  readonly #store: SqlCredentialStore;
  readonly #models: MutableModels;

  constructor(ctx: DurableObjectState, env: object) {
    super(ctx, env);
    // pi-ai は OAuth の実装を「バンドラが追えない動的 import」で読み込むため、Workers では解決できない。
    // 静的に束ねた実装を登録するこの入口は Bun の単体バイナリ向けだが、Workers でも同じ理由で必要になる。
    registerBunOAuthFlows();
    this.#store = new SqlCredentialStore(ctx.storage.sql);
    this.#models = createModels({
      credentials: this.#store,
      // 保存済みの認証情報だけを扱う。環境変数や認証ファイルへのフォールバックはしない
      authContext: { env: async () => undefined, fileExists: async () => false },
    });
    this.#models.setProvider(openaiProvider());
  }

  /**
   * 手元で `pi-ai login` して得た OAuth 認証情報を登録する。
   * ログイン自体はローカルのコールバックサーバーが要るため、Workers 上では実行できない。
   * 入力の不備は例外ではなく結果で返す（呼び出し側が利用者に理由を返せるように）。
   */
  async importCredential(providerId: string, credential: unknown): Promise<ImportResult> {
    if (!OAUTH_PROVIDERS.includes(providerId)) {
      return { ok: false, reason: `provider is not managed by the vault: ${providerId}` };
    }
    const reason = oauthCredentialProblem(credential);
    if (reason) return { ok: false, reason };
    await this.#store.modify(providerId, async () => credential as OAuthCredential);
    return { ok: true };
  }

  /**
   * いま有効なアクセストークンを API キー形式で返す。期限が切れていれば先に更新する。
   * 未登録（vault が管理しないプロバイダを含む）なら undefined。
   * 更新に失敗した場合（リフレッシュトークンの失効など）は例外になる。
   */
  async resolve(providerId: string): Promise<ApiKeyCredential | undefined> {
    if (!OAUTH_PROVIDERS.includes(providerId)) return undefined;
    const result = await this.#models.getAuth(providerId);
    const key = result?.auth.apiKey;
    return key ? { type: "api_key", key } : undefined;
  }

  /** 登録状況を返す。トークンそのものは含めない。 */
  async status(): Promise<VaultStatus[]> {
    const statuses: VaultStatus[] = [];
    for (const { providerId } of await this.#store.list()) {
      const credential = await this.#store.read(providerId);
      if (credential?.type === "oauth") {
        statuses.push({ providerId, expires: credential.expires });
      }
    }
    return statuses;
  }
}

/** OAuth 認証情報として不備があればその理由を、問題なければ undefined を返す。 */
function oauthCredentialProblem(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return "credential must be an object";
  const credential = value as Record<string, unknown>;
  if (credential.type !== "oauth") return 'credential.type must be "oauth"';
  // clientId はログイン時に OpenAI が発行するもので、これが無いとトークンを更新できない。
  // 登録時に弾かないと、最初の期限切れまで不備に気づけない
  for (const field of ["access", "refresh", "clientId"] as const) {
    if (typeof credential[field] !== "string" || credential[field] === "") {
      return `credential.${field} must be a non-empty string`;
    }
  }
  if (typeof credential.expires !== "number" || !Number.isFinite(credential.expires)) {
    return "credential.expires must be a number";
  }
  return undefined;
}
