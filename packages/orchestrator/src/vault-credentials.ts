import type { ApiKeyCredential, CredentialStore } from "@earendil-works/pi-ai";

/** サブスクリプションの OAuth で認証するプロバイダ。それ以外は API キーで、vault を通らない。 */
export const OAUTH_PROVIDERS: readonly string[] = ["openai"];

/** vault のうち、アクセストークンの取得に必要な部分。 */
export interface CredentialResolver {
  resolve(providerId: string): Promise<ApiKeyCredential | undefined>;
}

/**
 * vault を読み取り専用の CredentialStore として見せる。
 *
 * リクエストのたびに vault へ問い合わせるので、常に有効なアクセストークンが返る。
 * トークン更新（`modify`）を RPC 越しに行うことはできないため、書き込みは受け付けない。
 */
export function vaultCredentials(vault: CredentialResolver): CredentialStore {
  const readOnly = () => {
    throw new Error("credentials are managed by the vault and are read-only here");
  };
  return {
    read: async (providerId) =>
      OAUTH_PROVIDERS.includes(providerId) ? await vault.resolve(providerId) : undefined,
    // 保存済みの認証情報は vault 側にあり、ここからは列挙しない
    list: async () => [],
    modify: async () => readOnly(),
    delete: async () => readOnly(),
  };
}
