/** GitHub App の署名検証・installation token 発行・PR 操作クライアント。 */

export interface AppCredentials {
  readonly appId: string;
  readonly privateKey: string;
  readonly installationId: number;
}

export interface PullRequestClientOptions {
  /** `owner/name` 形式。 */
  readonly repository: string;
  readonly pullNumber: number;
  /** 都度（またはキャッシュ経由で）installation token を返す関数。 */
  readonly getToken: () => Promise<string>;
}

export interface PullRequestClient {
  getDiff(): Promise<string>;
  postReview(body: string): Promise<void>;
  resolveThread(threadId: string): Promise<void>;
}

const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const USER_AGENT = "adversarial-pr-review-harness";

/** 有効期限ギリギリのトークンを使わないための安全マージン（60 秒）。 */
const TOKEN_EXPIRY_MARGIN_MS = 60_000;

interface CachedToken {
  readonly token: string;
  readonly expiresAt: number;
}

const tokenCache = new Map<string, CachedToken>();

/** テスト等で installation token のキャッシュを明示的に消去する。 */
export function clearInstallationTokenCache(): void {
  tokenCache.clear();
}

/**
 * GitHub App の秘密鍵で RS256 署名の JWT を生成する。
 * PKCS#1 (`BEGIN RSA PRIVATE KEY`) と PKCS#8 (`BEGIN PRIVATE KEY`) の両方に対応する。
 */
export async function createAppJwt(
  appId: string,
  privateKey: string,
  nowMs: number = Date.now(),
): Promise<string> {
  const key = await importRsaPrivateKey(privateKey);
  const encoder = new TextEncoder();
  const nowSec = Math.floor(nowMs / 1000);
  const header = base64UrlEncode(encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const payload = base64UrlEncode(
    encoder.encode(
      JSON.stringify({
        iat: nowSec - 60,
        exp: nowSec + 540,
        iss: appId,
      }),
    ),
  );
  const signingInput = `${header}.${payload}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(signingInput)),
  );
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

/**
 * installation access token を発行する。
 * 有効期限内（期限の 60 秒前まで）はキャッシュしたトークンを再利用する。
 */
export async function issueInstallationToken(credentials: AppCredentials): Promise<string> {
  const cacheKey = `${credentials.appId}:${credentials.installationId}`;
  const now = Date.now();
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt - TOKEN_EXPIRY_MARGIN_MS > now) {
    return cached.token;
  }

  const jwt = await createAppJwt(credentials.appId, credentials.privateKey, now);
  const response = await fetch(
    `${GITHUB_API_BASE}/app/installations/${credentials.installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
        "User-Agent": USER_AGENT,
      },
    },
  );
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`failed to issue installation token (${response.status}): ${body}`);
  }

  const data = (await response.json()) as { token?: unknown; expires_at?: unknown };
  if (typeof data.token !== "string" || data.token.length === 0) {
    throw new Error("installation token response is missing token");
  }
  const expiresAt = typeof data.expires_at === "string" ? Date.parse(data.expires_at) : Number.NaN;
  if (Number.isFinite(expiresAt)) {
    tokenCache.set(cacheKey, { token: data.token, expiresAt });
  }
  return data.token;
}

/**
 * webhook の署名（X-Hub-Signature-256）を Web Crypto の HMAC-SHA256 で定数時間検証する。
 * 署名ヘッダが無い・形式が違う場合は false を返す。
 */
export async function verifyWebhookSignature(
  payload: string,
  signature: string | null | undefined,
  secret: string,
): Promise<boolean> {
  if (!signature || !secret) return false;
  const prefix = "sha256=";
  if (!signature.startsWith(prefix)) return false;
  const hex = signature.slice(prefix.length);
  if (!/^[0-9a-f]{64}$/i.test(hex)) return false;

  const expected = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    expected[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const actual = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)));
  return timingSafeEqualBytes(actual, expected);
}

/**
 * PR に対する差分取得・レビュー投稿・スレッド解決を行うクライアントを作る。
 */
export function createPullRequestClient(options: PullRequestClientOptions): PullRequestClient {
  return {
    async getDiff(): Promise<string> {
      const token = await options.getToken();
      const response = await fetch(
        `${GITHUB_API_BASE}/repos/${options.repository}/pulls/${options.pullNumber}`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github.v3.diff",
            "X-GitHub-Api-Version": GITHUB_API_VERSION,
            "User-Agent": USER_AGENT,
          },
        },
      );
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`failed to get pull request diff (${response.status}): ${text}`);
      }
      return response.text();
    },

    async postReview(body: string): Promise<void> {
      const token = await options.getToken();
      const response = await fetch(
        `${GITHUB_API_BASE}/repos/${options.repository}/pulls/${options.pullNumber}/reviews`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "Content-Type": "application/json",
            "X-GitHub-Api-Version": GITHUB_API_VERSION,
            "User-Agent": USER_AGENT,
          },
          body: JSON.stringify({ body, event: "COMMENT" }),
        },
      );
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`failed to post pull request review (${response.status}): ${text}`);
      }
    },

    async resolveThread(threadId: string): Promise<void> {
      const token = await options.getToken();
      const response = await fetch(`${GITHUB_API_BASE}/graphql`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "User-Agent": USER_AGENT,
        },
        body: JSON.stringify({
          query:
            "mutation($threadId: ID!) { resolveReviewThread(input: { threadId: $threadId }) { thread { id isResolved } } }",
          variables: { threadId },
        }),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`failed to resolve review thread (${response.status}): ${text}`);
      }
      const result = (await response.json()) as { errors?: Array<{ message?: string }> };
      if (result.errors && result.errors.length > 0) {
        const message = result.errors.map((e) => e.message ?? "GraphQL error").join("; ");
        throw new Error(`failed to resolve review thread: ${message}`);
      }
    },
  };
}

function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64Decode(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function importRsaPrivateKey(pem: string) {
  const normalized = pem.replace(/\\n/g, "\n").trim();
  let pkcs8Bytes: Uint8Array;

  if (normalized.includes("-----BEGIN RSA PRIVATE KEY-----")) {
    const body = normalized
      .replace(/-----BEGIN RSA PRIVATE KEY-----/g, "")
      .replace(/-----END RSA PRIVATE KEY-----/g, "")
      .replace(/\s+/g, "");
    pkcs8Bytes = wrapPkcs1InPkcs8(base64Decode(body));
  } else if (normalized.includes("-----BEGIN PRIVATE KEY-----")) {
    const body = normalized
      .replace(/-----BEGIN PRIVATE KEY-----/g, "")
      .replace(/-----END PRIVATE KEY-----/g, "")
      .replace(/\s+/g, "");
    pkcs8Bytes = base64Decode(body);
  } else {
    throw new Error("unsupported private key format: expected PKCS#1 or PKCS#8 PEM");
  }

  const buffer = pkcs8Bytes.buffer.slice(
    pkcs8Bytes.byteOffset,
    pkcs8Bytes.byteOffset + pkcs8Bytes.byteLength,
  ) as ArrayBuffer;
  return crypto.subtle.importKey(
    "pkcs8",
    buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

/**
 * PKCS#1 (RSAPrivateKey) DER を PKCS#8 (PrivateKeyInfo) DER で包む。
 * Web Crypto の `importKey("pkcs8", ...)` は PKCS#1 を直接受け付けないため変換する。
 */
function wrapPkcs1InPkcs8(pkcs1Der: Uint8Array): Uint8Array {
  // INTEGER 0 + SEQUENCE { OID rsaEncryption (1.2.840.113549.1.1.1), NULL }
  const algorithmHeader = new Uint8Array([
    0x02, 0x01, 0x00, 0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
    0x05, 0x00,
  ]);
  const octetString = encodeDerTlv(0x04, pkcs1Der);
  const inner = new Uint8Array(algorithmHeader.byteLength + octetString.byteLength);
  inner.set(algorithmHeader, 0);
  inner.set(octetString, algorithmHeader.byteLength);
  return encodeDerTlv(0x30, inner);
}

function encodeDerTlv(tag: number, content: Uint8Array): Uint8Array {
  const lengthBytes = encodeDerLength(content.byteLength);
  const result = new Uint8Array(1 + lengthBytes.byteLength + content.byteLength);
  result[0] = tag;
  result.set(lengthBytes, 1);
  result.set(content, 1 + lengthBytes.byteLength);
  return result;
}

function encodeDerLength(length: number): Uint8Array {
  if (length < 0x80) {
    return new Uint8Array([length]);
  }
  const bytes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining >>= 8;
  }
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}
