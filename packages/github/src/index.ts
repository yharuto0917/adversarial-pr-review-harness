/** GitHub App の署名検証・installation token 発行・PR 操作クライアント。 */

import {
  GITHUB_API_BASE,
  GITHUB_API_VERSION,
  GITHUB_USER_AGENT,
  sanitizeGitHubErrorBody,
} from "./client.js";
import {
  type AppCredentials,
  GitHubApiError,
  type GitHubPermissionLevel,
  type InstallationTokenScope,
} from "./types.js";

export * from "./client.js";
export * from "./types.js";

/** 有効期限ギリギリのトークンを使わないための安全マージン（60 秒）。 */
const TOKEN_EXPIRY_MARGIN_MS = 60_000;

/** オンメモリトークンキャッシュの上限件数。 */
const MAX_TOKEN_CACHE_ENTRIES = 500;

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
 * `scope` を指定すると対象リポジトリ・権限を最小限に絞ったトークンを発行し、
 * スコープ単位でキャッシュを分離する。有効期限内（期限の 60 秒前まで）はキャッシュを再利用する。
 */
export async function issueInstallationToken(
  credentials: AppCredentials,
  scope?: InstallationTokenScope,
): Promise<string> {
  const normalizedScope = normalizeTokenScope(scope);
  const cacheKey = buildTokenCacheKey(credentials, normalizedScope);
  const now = Date.now();
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt - TOKEN_EXPIRY_MARGIN_MS > now) {
    return cached.token;
  }

  const jwt = await createAppJwt(credentials.appId, credentials.privateKey, now);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${jwt}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
    "User-Agent": GITHUB_USER_AGENT,
  };
  let body: string | undefined;
  if (normalizedScope !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(normalizedScope);
  }

  const response = await fetch(
    `${GITHUB_API_BASE}/app/installations/${credentials.installationId}/access_tokens`,
    {
      method: "POST",
      headers,
      ...(body !== undefined ? { body } : {}),
    },
  );
  if (!response.ok) {
    const errorBody = sanitizeGitHubErrorBody(await response.text().catch(() => ""));
    const code =
      response.status === 401 || response.status === 403 || response.status === 422
        ? "GITHUB_PERMISSION_DENIED"
        : "GITHUB_API_ERROR";
    throw new GitHubApiError(
      code,
      response.status,
      `failed to issue installation token (${response.status}): ${errorBody}`,
    );
  }

  const data = (await response.json()) as { token?: unknown; expires_at?: unknown };
  if (typeof data.token !== "string" || data.token.length === 0) {
    throw new GitHubApiError(
      "GITHUB_INVALID_RESPONSE",
      response.status,
      "installation token response is missing token",
    );
  }
  const expiresAt = typeof data.expires_at === "string" ? Date.parse(data.expires_at) : Number.NaN;
  if (Number.isFinite(expiresAt)) {
    evictExpiredOrOverflowCache(now);
    tokenCache.set(cacheKey, { token: data.token, expiresAt });
  }
  return data.token;
}

function evictExpiredOrOverflowCache(now: number): void {
  if (tokenCache.size < MAX_TOKEN_CACHE_ENTRIES) {
    return;
  }
  for (const [key, entry] of tokenCache.entries()) {
    if (entry.expiresAt - TOKEN_EXPIRY_MARGIN_MS <= now) {
      tokenCache.delete(key);
    }
  }
  while (tokenCache.size >= MAX_TOKEN_CACHE_ENTRIES) {
    const oldestKey = tokenCache.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    tokenCache.delete(oldestKey);
  }
}

interface NormalizedTokenScope {
  readonly repositories?: readonly string[];
  readonly permissions?: Readonly<Record<string, GitHubPermissionLevel>>;
}

const SAFE_REPOSITORY_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

function normalizeTokenScope(
  scope: InstallationTokenScope | undefined,
): NormalizedTokenScope | undefined {
  if (!scope) {
    return undefined;
  }

  let repositories: string[] | undefined;
  if (scope.repositories !== undefined) {
    if (scope.repositories.length === 0) {
      throw new Error("installation token repositories scope must not be empty");
    }
    const unique = new Set<string>();
    for (const raw of scope.repositories) {
      const repo = raw.trim();
      if (!SAFE_REPOSITORY_NAME_PATTERN.test(repo) || repo.includes("..")) {
        throw new Error(
          `invalid repository name for installation token scope (expected repo name without owner): "${raw}"`,
        );
      }
      unique.add(repo);
    }
    repositories = [...unique].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }

  let permissions: Record<string, GitHubPermissionLevel> | undefined;
  if (scope.permissions !== undefined) {
    const entries = Object.entries(scope.permissions).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    if (entries.length === 0) {
      throw new Error("installation token permissions scope must not be empty");
    }
    for (const [key, level] of entries) {
      if (key.trim().length === 0 || (level !== "read" && level !== "write")) {
        throw new Error(`invalid installation token permission: "${key}" = "${String(level)}"`);
      }
    }
    permissions = Object.fromEntries(entries);
  }

  if (repositories === undefined && permissions === undefined) {
    return undefined;
  }
  return {
    ...(repositories !== undefined ? { repositories } : {}),
    ...(permissions !== undefined ? { permissions } : {}),
  };
}

function buildTokenCacheKey(
  credentials: AppCredentials,
  scope: NormalizedTokenScope | undefined,
): string {
  const base = `${credentials.appId}:${credentials.installationId}`;
  if (!scope) {
    return base;
  }
  return `${base}:${JSON.stringify(scope)}`;
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
