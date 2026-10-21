import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearInstallationTokenCache,
  createAppJwt,
  createPullRequestClient,
  issueInstallationToken,
  verifyWebhookSignature,
} from "./index.js";

const { privateKey: pkcs1Pem, publicKey: spkiPem } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
});

const { privateKey: pkcs8Pem } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

function base64UrlDecode(input: string): ArrayBuffer {
  const padded = input
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(input.length / 4) * 4, "=");
  const bytes = new Uint8Array(Buffer.from(padded, "base64"));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

describe("verifyWebhookSignature", () => {
  const secret = "It's a Secret to Everybody";
  const payload = "Hello, World!";
  // GitHub 公式ドキュメント「Validating webhook deliveries」の検証例
  const validSignature = "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";

  it("GitHub ドキュメントの検証例に対して true を返す", async () => {
    await expect(verifyWebhookSignature(payload, validSignature, secret)).resolves.toBe(true);
  });

  it("ペイロードまたは署名が改ざんされている場合は false を返す", async () => {
    await expect(verifyWebhookSignature("Hello, Tampered!", validSignature, secret)).resolves.toBe(
      false,
    );
    const tamperedSig = `${validSignature.slice(0, -1)}0`;
    await expect(verifyWebhookSignature(payload, tamperedSig, secret)).resolves.toBe(false);
  });

  it("署名ヘッダが欠落している、または形式が不正な場合は false を返す", async () => {
    await expect(verifyWebhookSignature(payload, undefined, secret)).resolves.toBe(false);
    await expect(verifyWebhookSignature(payload, null, secret)).resolves.toBe(false);
    await expect(verifyWebhookSignature(payload, "", secret)).resolves.toBe(false);
    await expect(verifyWebhookSignature(payload, "sha1=757107ea", secret)).resolves.toBe(false);
    await expect(verifyWebhookSignature(payload, "sha256=short", secret)).resolves.toBe(false);
    await expect(verifyWebhookSignature(payload, `sha256=${"z".repeat(64)}`, secret)).resolves.toBe(
      false,
    );
  });
});

describe("createAppJwt / issueInstallationToken", () => {
  beforeEach(() => {
    clearInstallationTokenCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("PKCS#1 形式の秘密鍵から RS256 署名の有効な JWT を生成する", async () => {
    const now = 1_700_000_000_000;
    const jwt = await createAppJwt("12345", pkcs1Pem, now);
    const parts = jwt.split(".");
    expect(parts).toHaveLength(3);
    const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

    const header = JSON.parse(new TextDecoder().decode(base64UrlDecode(headerB64)));
    const claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadB64)));
    expect(header).toEqual({ alg: "RS256", typ: "JWT" });
    expect(claims).toEqual({
      iss: "12345",
      iat: 1_700_000_000 - 60,
      exp: 1_700_000_000 + 540,
    });

    const spkiDer = Buffer.from(
      spkiPem
        .replace(/-----BEGIN PUBLIC KEY-----/g, "")
        .replace(/-----END PUBLIC KEY-----/g, "")
        .replace(/\s+/g, ""),
      "base64",
    );
    const pubKey = await crypto.subtle.importKey(
      "spki",
      spkiDer,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      pubKey,
      base64UrlDecode(signatureB64),
      new TextEncoder().encode(`${headerB64}.${payloadB64}`),
    );
    expect(valid).toBe(true);
  });

  it("PKCS#8 形式の秘密鍵や改行エスケープ付き鍵でも JWT を生成できる", async () => {
    const escapedPkcs1 = pkcs1Pem.replace(/\n/g, "\\n");
    const jwt1 = await createAppJwt("99", escapedPkcs1);
    const jwt2 = await createAppJwt("99", pkcs8Pem);
    expect(jwt1.split(".")).toHaveLength(3);
    expect(jwt2.split(".")).toHaveLength(3);
  });

  it("POST /app/installations/{id}/access_tokens でトークンを発行し、有効期限内はキャッシュを再利用する", async () => {
    const calls: Array<{ url: string; method: string | undefined; auth: string | undefined }> = [];
    const futureIso = new Date(Date.now() + 3600_000).toISOString();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        calls.push({
          url: String(input),
          method: init?.method,
          auth: headers.get("Authorization") ?? undefined,
        });
        return new Response(JSON.stringify({ token: "ghs_test_token_1", expires_at: futureIso }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    const credentials = { appId: "12345", privateKey: pkcs1Pem, installationId: 67890 };
    const first = await issueInstallationToken(credentials);
    const second = await issueInstallationToken(credentials);

    expect(first).toBe("ghs_test_token_1");
    expect(second).toBe("ghs_test_token_1");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.github.com/app/installations/67890/access_tokens");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.auth).toMatch(/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it("キャッシュ済みトークンの有効期限が切れている場合は再発行する", async () => {
    let count = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        count += 1;
        // 1 回目は期限切れ直前（30 秒後）、2 回目は 1 時間後
        const expiresAt = new Date(Date.now() + (count === 1 ? 30_000 : 3600_000)).toISOString();
        return Response.json(
          { token: `ghs_token_${count}`, expires_at: expiresAt },
          { status: 201 },
        );
      }),
    );

    const credentials = { appId: "12345", privateKey: pkcs1Pem, installationId: 111 };
    const first = await issueInstallationToken(credentials);
    const second = await issueInstallationToken(credentials);

    expect(first).toBe("ghs_token_1");
    expect(second).toBe("ghs_token_2");
    expect(count).toBe(2);
  });
});

describe("createPullRequestClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("getDiff / postReview / resolveThread が対応する GitHub API を呼ぶ", async () => {
    const requests: Array<{
      url: string;
      method: string | undefined;
      accept: string | undefined;
      auth: string | undefined;
      body: string | undefined;
    }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const headers = new Headers(init?.headers);
        requests.push({
          url,
          method: init?.method,
          accept: headers.get("Accept") ?? undefined,
          auth: headers.get("Authorization") ?? undefined,
          body: typeof init?.body === "string" ? init.body : undefined,
        });
        if (url.endsWith("/pulls/7")) {
          return new Response("diff --git a/a.ts b/a.ts", { status: 200 });
        }
        if (url.endsWith("/pulls/7/reviews")) {
          return Response.json({ id: 1 }, { status: 200 });
        }
        if (url.endsWith("/graphql")) {
          return Response.json({
            data: { resolveReviewThread: { thread: { id: "PRRT_1", isResolved: true } } },
          });
        }
        return new Response("not found", { status: 404 });
      }),
    );

    const client = createPullRequestClient({
      repository: "octo/repo",
      pullNumber: 7,
      getToken: async () => "ghs_pr_token",
    });

    await expect(client.getDiff()).resolves.toBe("diff --git a/a.ts b/a.ts");
    await client.postReview("LGTM with minor notes");
    await client.resolveThread("PRRT_1");

    expect(requests).toEqual([
      {
        url: "https://api.github.com/repos/octo/repo/pulls/7",
        method: "GET",
        accept: "application/vnd.github.v3.diff",
        auth: "Bearer ghs_pr_token",
        body: undefined,
      },
      {
        url: "https://api.github.com/repos/octo/repo/pulls/7/reviews",
        method: "POST",
        accept: "application/vnd.github+json",
        auth: "Bearer ghs_pr_token",
        body: JSON.stringify({ body: "LGTM with minor notes", event: "COMMENT" }),
      },
      {
        url: "https://api.github.com/graphql",
        method: "POST",
        accept: "application/vnd.github+json",
        auth: "Bearer ghs_pr_token",
        body: JSON.stringify({
          query:
            "mutation($threadId: ID!) { resolveReviewThread(input: { threadId: $threadId }) { thread { id isResolved } } }",
          variables: { threadId: "PRRT_1" },
        }),
      },
    ]);
  });
});
