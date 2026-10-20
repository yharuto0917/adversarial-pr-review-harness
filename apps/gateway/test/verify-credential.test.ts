import { SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

const TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token";
const RESPONSES_URL = "https://api.openai.com/v1/responses";
const authorized = { authorization: "Bearer test-admin-token" };

const expired = {
  type: "oauth",
  access: "old-access",
  refresh: "old-refresh",
  expires: Date.now() - 1_000,
  clientId: "client-123",
  scopes: ["chatgpt.tokens.use.direct"],
};

/** Responses API のストリームを、テキスト「OK」を返すだけの最小構成で組み立てる。 */
function okStream(): Response {
  const events = [
    { type: "response.created", response: { id: "resp_1" } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", id: "msg_1", role: "assistant", content: [] },
    },
    { type: "response.output_text.delta", output_index: 0, delta: "OK" },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "message", id: "msg_1", content: [{ type: "output_text", text: "OK" }] },
    },
    {
      type: "response.completed",
      response: {
        id: "resp_1",
        status: "completed",
        usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 },
      },
    },
  ];
  const body = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

/** OpenAI への通信を差し替え、推論の要求に付いた Authorization を記録する。 */
function stubOpenAI(responses: () => Response) {
  const authorizations: (string | null)[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url === TOKEN_URL) {
      return Response.json({
        access_token: "new-access",
        refresh_token: "new-refresh",
        scope: "openid chatgpt.tokens.use.direct",
        expires_in: 3600,
      });
    }
    if (request.url === RESPONSES_URL) {
      authorizations.push(request.headers.get("authorization"));
      return responses();
    }
    throw new Error(`unexpected fetch: ${request.url}`);
  });
  return authorizations;
}

function register(credential: unknown) {
  return SELF.fetch("https://example.com/admin/credentials/openai", {
    method: "PUT",
    headers: authorized,
    body: JSON.stringify(credential),
  });
}

function verify(query = "?model=openai/gpt-6-sol") {
  return SELF.fetch(`https://example.com/admin/credentials/openai/verify${query}`, {
    method: "POST",
    headers: authorized,
  });
}

describe("POST /admin/credentials/:providerId/verify", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("期限切れのトークンを更新してから、新しいトークンで推論する", async () => {
    const authorizations = stubOpenAI(okStream);
    await register(expired);

    const response = await verify();

    expect(response.status).toBe(200);
    const body = await response.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      ok: true,
      model: "openai/gpt-6-sol",
      reply: "OK",
      refreshed: true,
    });
    expect(body.expiresAfter).toBeGreaterThan(Date.now());
    // レビュー時と同じく、vault から受け取ったアクセストークンが API キーとして送られる
    expect(authorizations).toEqual(["Bearer new-access"]);
    // 応答にトークンを含めない
    expect(JSON.stringify(body)).not.toContain("new-access");
    expect(JSON.stringify(body)).not.toContain("new-refresh");
  });

  it("推論が拒否されたら 502 とエラー内容を返す", async () => {
    stubOpenAI(() =>
      Response.json(
        { error: { message: "invalid token", type: "invalid_request_error" } },
        { status: 401 },
      ),
    );
    await register(expired);

    const response = await verify();

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({ ok: false, refreshed: true });
  });

  it("指定したモデルのプロバイダが違えば 400 を返す", async () => {
    const response = await verify("?model=google/gemini-3-pro");

    expect(response.status).toBe(400);
  });

  it("存在しないモデルは 400 を返す", async () => {
    const response = await verify("?model=openai/no-such-model");

    expect(response.status).toBe(400);
  });
});
