import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

const TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token";

const expired = {
  type: "oauth",
  access: "old-access",
  refresh: "old-refresh",
  expires: Date.now() - 1_000,
  clientId: "client-123",
  scopes: ["chatgpt.tokens.use.direct"],
};

/** トークンエンドポイントだけを偽の応答に差し替え、受け取ったリクエスト本文を記録する。 */
function stubTokenEndpoint() {
  const requests: URLSearchParams[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (url !== TOKEN_URL) throw new Error(`unexpected fetch: ${url}`);
    requests.push(new URLSearchParams(String(init?.body)));
    // 実際の通信と同じく待ちを挟み、その間に他の呼び出しが割り込めるようにする
    await new Promise((resolve) => setTimeout(resolve, 20));
    return Response.json({
      access_token: `access-${requests.length}`,
      refresh_token: `refresh-${requests.length}`,
      scope: "openid chatgpt.tokens.use.direct",
      expires_in: 3600,
    });
  });
  return requests;
}

describe("CredentialVault", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("未登録なら undefined を返す", async () => {
    const vault = env.VAULT.getByName("empty");

    await expect(vault.resolve("openai")).resolves.toBeUndefined();
  });

  it("期限切れのトークンを更新し、ローテーション後のリフレッシュトークンを保存する", async () => {
    const requests = stubTokenEndpoint();
    const vault = env.VAULT.getByName("refresh");
    await vault.importCredential("openai", expired);

    const first = await vault.resolve("openai");
    const second = await vault.resolve("openai");

    expect(first).toEqual({ type: "api_key", key: "access-1" });
    // 更新後は期限内なので、2 回目はトークンエンドポイントを呼ばない
    expect(second).toEqual({ type: "api_key", key: "access-1" });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.get("grant_type")).toBe("refresh_token");
    expect(requests[0]?.get("refresh_token")).toBe("old-refresh");
    expect(requests[0]?.get("client_id")).toBe("client-123");
    const [status] = await vault.status();
    expect(status?.providerId).toBe("openai");
    expect(status?.expires).toBeGreaterThan(Date.now());
  });

  it("同時に解決を求められても、更新は 1 度しか行わない", async () => {
    const requests = stubTokenEndpoint();
    const vault = env.VAULT.getByName("concurrent");
    await vault.importCredential("openai", expired);

    const resolved = await Promise.all([
      vault.resolve("openai"),
      vault.resolve("openai"),
      vault.resolve("openai"),
    ]);

    expect(requests).toHaveLength(1);
    expect(resolved.map((credential) => credential?.key)).toEqual([
      "access-1",
      "access-1",
      "access-1",
    ]);
  });

  it("vault が管理しないプロバイダは登録も解決もしない", async () => {
    const vault = env.VAULT.getByName("unmanaged");

    await expect(vault.importCredential("google", expired)).resolves.toMatchObject({ ok: false });
    await expect(vault.resolve("google")).resolves.toBeUndefined();
    await expect(vault.status()).resolves.toEqual([]);
  });

  it("API キー形式の認証情報は登録できない", async () => {
    const vault = env.VAULT.getByName("invalid");

    const result = await vault.importCredential("openai", { type: "api_key", key: "sk-test" });

    expect(result).toEqual({ ok: false, reason: 'credential.type must be "oauth"' });
    await expect(vault.status()).resolves.toEqual([]);
  });
});
