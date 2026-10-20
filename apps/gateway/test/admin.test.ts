import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const authorized = { authorization: "Bearer test-admin-token" };

const credential = {
  type: "oauth",
  access: "access",
  refresh: "refresh",
  expires: 4_102_444_800_000,
  clientId: "client-123",
};

function put(providerId: string, body: unknown, headers: Record<string, string> = authorized) {
  return SELF.fetch(`https://example.com/admin/credentials/${providerId}`, {
    method: "PUT",
    headers,
    body: JSON.stringify(body),
  });
}

describe("/admin", () => {
  it.each([
    ["ヘッダー無し", {}],
    ["誤ったトークン", { authorization: "Bearer wrong" }],
    ["前方一致するだけのトークン", { authorization: "Bearer test-admin" }],
  ])("%s は 401 を返し、登録もしない", async (_name, headers) => {
    const response = await put("openai", credential, headers);

    expect(response.status).toBe(401);
    const list = await SELF.fetch("https://example.com/admin/credentials", { headers: authorized });
    await expect(list.json()).resolves.toEqual({ ok: true, credentials: [] });
  });

  it("登録した認証情報は、トークンを含まない形で一覧に出る", async () => {
    const response = await put("openai", credential);
    const list = await SELF.fetch("https://example.com/admin/credentials", { headers: authorized });

    expect(response.status).toBe(200);
    await expect(list.json()).resolves.toEqual({
      ok: true,
      credentials: [{ providerId: "openai", expires: 4_102_444_800_000 }],
    });
  });

  it("vault が管理しないプロバイダは 400 を返す", async () => {
    const response = await put("google", credential);

    expect(response.status).toBe(400);
  });

  it("項目の欠けた認証情報は 400 を返す", async () => {
    const response = await put("openai", { type: "oauth", access: "access" });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ ok: false });
  });
});
