/**
 * サンドボックスの外向き HTTP/HTTPS 通信に対するポリシー判定・リクエスト再構築・構造化監査ログ。
 *
 * ContainerProxy の WorkerEntrypoint（ReviewSandbox.outbound / outboundHandlers）から呼ばれ、
 * 許可・拒否のすべての外向き通信を一元的に検査・記録する。
 */

export type EgressPhase = "locked" | "checkout" | "install";

export interface LockedEgressParams {
  readonly logicalSandboxId?: string;
}

export interface CheckoutEgressParams {
  /** `owner/name` 形式。 */
  readonly repository: string;
  /** ReviewSandbox DO のオンメモリ認証トークン参照 ID（トークン本体は渡さない）。 */
  readonly tokenId?: string;
  /** この一時許可の失効時刻（epoch ミリ秒）。 */
  readonly expiresAt: number;
  readonly logicalSandboxId?: string;
}

export interface InstallEgressParams {
  /** この一時許可の失効時刻（epoch ミリ秒）。 */
  readonly expiresAt: number;
  readonly logicalSandboxId?: string;
}

export type EgressPolicyInput =
  | { readonly phase: "locked"; readonly params?: LockedEgressParams | undefined }
  | { readonly phase: "checkout"; readonly params?: CheckoutEgressParams | undefined }
  | { readonly phase: "install"; readonly params?: InstallEgressParams | undefined };

export type EgressDenyReason =
  | "invalid_url"
  | "phase_locked"
  | "policy_expired"
  | "invalid_policy_params"
  | "insecure_scheme"
  | "port_not_allowed"
  | "userinfo_not_allowed"
  | "invalid_hostname"
  | "host_header_mismatch"
  | "private_host_denied"
  | "method_not_allowed"
  | "upgrade_not_allowed"
  | "host_not_allowed"
  | "path_not_allowed"
  | "checkout_auth_unavailable";

export interface EgressAuditLog {
  readonly event: "sandbox.egress";
  readonly decision: "allow" | "deny";
  readonly reason: string;
  readonly sandboxId: string;
  readonly logicalSandboxId?: string;
  readonly phase: EgressPhase;
  readonly method: string;
  readonly protocol: string;
  readonly host: string;
  readonly port: number | null;
  readonly path: string;
  readonly pathTruncated: boolean;
  readonly status: number;
  readonly durationMs: number;
}

export interface EgressLogger {
  info(entry: EgressAuditLog): void;
  warn(entry: EgressAuditLog): void;
}

export interface EgressHandlerDeps {
  readonly fetchImpl?: typeof fetch;
  readonly logger?: EgressLogger;
  readonly now?: () => number;
  readonly extraInstallHosts?: readonly string[];
  /**
   * checkout フェーズで Worker 側のオンメモリトークンを解決するフック。
   * トークンが取得できない場合は null を返し、呼び出し側で fail-closed (403) とする。
   */
  readonly resolveCheckoutAuthorization?: (
    tokenId: string,
    repository: string,
  ) => Promise<string | null>;
}

export interface OutboundExecutionContext {
  readonly containerId: string;
}

export const CHECKOUT_ALLOWED_HOST = "github.com";

export const DEFAULT_INSTALL_ALLOWED_HOSTS: readonly string[] = [
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "repo.yarnpkg.com",
];

/** checkout 一時許可の既定 TTL（2 分）。 */
export const CHECKOUT_EGRESS_TTL_MS = 2 * 60 * 1_000;

/** install 一時許可の既定 TTL（10 分）。 */
export const INSTALL_EGRESS_TTL_MS = 10 * 60 * 1_000;

const MAX_AUDIT_PATH_LENGTH = 256;
const SAFE_REPOSITORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const DNS_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const RESERVED_INTERNAL_SUFFIXES = [".localhost", ".local", ".internal", ".arpa"] as const;

const STRIPPED_FORWARD_HEADERS = new Set([
  "authorization",
  "cookie",
  "host",
  "connection",
  "upgrade",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "proxy-authorization",
  "proxy-connection",
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
]);

export const defaultEgressLogger: EgressLogger = {
  info(entry) {
    console.log(entry);
  },
  warn(entry) {
    console.warn(entry);
  },
};

export interface EvaluatedRequestMeta {
  readonly method: string;
  readonly protocol: string;
  readonly host: string;
  readonly port: number | null;
  readonly rawPathname: string;
  readonly rawSearch: string;
  readonly auditPath: string;
  readonly pathTruncated: boolean;
}

export type EgressEvaluation =
  | {
      readonly decision: "allow";
      readonly reason: string;
      readonly meta: EvaluatedRequestMeta;
      readonly normalizedRepository?: string;
      readonly tokenId?: string;
    }
  | {
      readonly decision: "deny";
      readonly reason: EgressDenyReason;
      readonly meta: EvaluatedRequestMeta;
    };

/**
 * `SANDBOX_EXTRA_ALLOWED_HOSTS`（カンマ区切り）を検証・正規化する。
 * IP リテラル・ワイルドカード・内部ドメイン・不正なホスト名を含む場合は例外を投げる。
 */
export function parseExtraAllowedHosts(raw: string | undefined): readonly string[] {
  if (raw === undefined || raw.trim().length === 0) {
    return [];
  }

  const hosts: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const candidate = part.trim().toLowerCase();
    if (candidate.length === 0) {
      continue;
    }
    if (!isValidPublicFqdn(candidate)) {
      throw new Error(`invalid hostname in SANDBOX_EXTRA_ALLOWED_HOSTS: "${part.trim()}"`);
    }
    if (!seen.has(candidate)) {
      seen.add(candidate);
      hosts.push(candidate);
    }
  }
  return hosts;
}

/** 公開インターネット上の厳格な FQDN かを判定する（IP リテラル・予約ドメイン・ワイルドカードは拒否）。 */
export function isValidPublicFqdn(hostname: string): boolean {
  if (hostname.length === 0 || hostname.length > 253) {
    return false;
  }
  if (hostname.startsWith(".") || hostname.endsWith(".")) {
    return false;
  }
  if (isPrivateOrInternalHost(hostname)) {
    return false;
  }
  const labels = hostname.split(".");
  if (labels.length < 2) {
    return false;
  }
  const tld = labels[labels.length - 1];
  if (!tld || /^[0-9]+$/.test(tld) || /^0x[0-9a-f]+$/i.test(tld)) {
    return false;
  }
  return labels.every((label) => DNS_LABEL_PATTERN.test(label));
}

/** ローカル・プライベート・内部ドメイン・IP リテラル（IPv4/IPv6/数値表現）を判定する。 */
export function isPrivateOrInternalHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (lower.length === 0 || lower === "localhost") {
    return true;
  }
  if (RESERVED_INTERNAL_SUFFIXES.some((suffix) => lower.endsWith(suffix))) {
    return true;
  }
  // IPv6 リテラル（ブラケット付きまたはコロン含む）
  if (lower.startsWith("[") || lower.endsWith("]") || lower.includes(":")) {
    return true;
  }
  // 10進整数 / 16進整数単一ラベル（例: 2130706433, 0x7f000001）
  if (/^(?:[0-9]+|0x[0-9a-f]+)$/i.test(lower)) {
    return true;
  }
  // ドット区切りの数値 IPv4（10進・8進・16進混在を含む）
  const parts = lower.split(".");
  if (parts.length > 0 && parts.every((part) => /^(?:[0-9]+|0x[0-9a-f]+)$/i.test(part))) {
    return true;
  }
  return false;
}

/**
 * 外向きリクエストを現在のフェーズポリシーに照らして判定する純粋関数。
 */
export function evaluateEgressRequest(
  request: Request,
  policy: EgressPolicyInput,
  options: {
    readonly nowMs: number;
    readonly extraInstallHosts?: readonly string[];
  },
): EgressEvaluation {
  const method = request.method.toUpperCase();
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return {
      decision: "deny",
      reason: "invalid_url",
      meta: {
        method,
        protocol: "",
        host: "",
        port: null,
        rawPathname: "",
        rawSearch: "",
        auditPath: "",
        pathTruncated: false,
      },
    };
  }

  const rawHost = url.hostname.toLowerCase();
  const { path: auditPath, truncated: pathTruncated } = sanitizeAuditPath(url.pathname);
  const effectivePort = resolvePortNumber(url);
  const meta: EvaluatedRequestMeta = {
    method,
    protocol: url.protocol,
    host: rawHost,
    port: effectivePort,
    rawPathname: url.pathname,
    rawSearch: url.search,
    auditPath,
    pathTruncated,
  };

  if (policy.phase === "locked") {
    return { decision: "deny", reason: "phase_locked", meta };
  }

  // 共通セキュリティ検査（全許可フェーズで最優先）
  if (method === "CONNECT") {
    return { decision: "deny", reason: "method_not_allowed", meta };
  }
  const upgradeHeader = request.headers.get("upgrade");
  if (upgradeHeader !== null && upgradeHeader.trim().length > 0) {
    return { decision: "deny", reason: "upgrade_not_allowed", meta };
  }
  if (url.protocol !== "https:") {
    return { decision: "deny", reason: "insecure_scheme", meta };
  }
  // WHATWG URL は https: の 443 を "" に正規化するため、非空は 443 以外の明示ポート
  if (url.port !== "") {
    return { decision: "deny", reason: "port_not_allowed", meta };
  }
  if (url.username !== "" || url.password !== "") {
    return { decision: "deny", reason: "userinfo_not_allowed", meta };
  }
  if (rawHost.length === 0 || rawHost.endsWith(".") || rawHost.startsWith(".")) {
    return { decision: "deny", reason: "invalid_hostname", meta };
  }
  if (isPrivateOrInternalHost(rawHost)) {
    return { decision: "deny", reason: "private_host_denied", meta };
  }
  if (!isValidPublicFqdn(rawHost)) {
    return { decision: "deny", reason: "invalid_hostname", meta };
  }
  if (!matchesHostHeader(request.headers.get("host"), rawHost)) {
    return { decision: "deny", reason: "host_header_mismatch", meta };
  }
  const rawPathFromUrl = extractRawPath(request.url);
  if (
    hasUnsafePathCharactersOrTraversal(url.pathname) ||
    hasUnsafePathCharactersOrTraversal(rawPathFromUrl)
  ) {
    return { decision: "deny", reason: "path_not_allowed", meta };
  }

  if (policy.phase === "checkout") {
    return evaluateCheckoutPolicy(meta, policy.params, options.nowMs);
  }

  return evaluateInstallPolicy(meta, policy.params, options.nowMs, options.extraInstallHosts ?? []);
}

/**
 * ContainerProxy のハンドラ本体。
 * ポリシー評価 → 必要時トークン注入 → 安全な Request 再構築 → fetch (redirect: manual) → 監査ログ出力を行う。
 */
export async function handleOutboundRequest(
  request: Request,
  policy: EgressPolicyInput,
  ctx: OutboundExecutionContext,
  deps: EgressHandlerDeps = {},
): Promise<Response> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const logger = deps.logger ?? defaultEgressLogger;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const logicalSandboxId = policy.params?.logicalSandboxId;

  const evaluation = evaluateEgressRequest(request, policy, {
    nowMs: startedAt,
    ...(deps.extraInstallHosts ? { extraInstallHosts: deps.extraInstallHosts } : {}),
  });

  if (evaluation.decision === "deny") {
    const status = 403;
    logger.warn(
      buildAuditLog({
        decision: "deny",
        reason: evaluation.reason,
        sandboxId: ctx.containerId,
        logicalSandboxId,
        phase: policy.phase,
        meta: evaluation.meta,
        status,
        durationMs: Math.max(0, now() - startedAt),
      }),
    );
    return new Response(`Forbidden by sandbox egress policy: ${evaluation.reason}`, { status });
  }

  let injectedAuthorization: string | undefined;
  if (evaluation.tokenId !== undefined) {
    if (!deps.resolveCheckoutAuthorization || !evaluation.normalizedRepository) {
      return denyRuntime(
        logger,
        "checkout_auth_unavailable",
        ctx.containerId,
        logicalSandboxId,
        policy.phase,
        evaluation.meta,
        Math.max(0, now() - startedAt),
      );
    }
    let resolved: string | null;
    try {
      resolved = await deps.resolveCheckoutAuthorization(
        evaluation.tokenId,
        evaluation.normalizedRepository,
      );
    } catch (error) {
      console.error({
        event: "sandbox.egress.checkout_auth_error",
        sandboxId: ctx.containerId,
        ...(logicalSandboxId !== undefined ? { logicalSandboxId } : {}),
        error: error instanceof Error ? error.message : String(error),
      });
      resolved = null;
    }
    if (!resolved) {
      return denyRuntime(
        logger,
        "checkout_auth_unavailable",
        ctx.containerId,
        logicalSandboxId,
        policy.phase,
        evaluation.meta,
        Math.max(0, now() - startedAt),
      );
    }
    injectedAuthorization = resolved;
  }

  const upstreamRequest = buildUpstreamRequest(request, evaluation.meta, injectedAuthorization);

  try {
    const response = await fetchImpl(upstreamRequest);
    logger.info(
      buildAuditLog({
        decision: "allow",
        reason: evaluation.reason,
        sandboxId: ctx.containerId,
        logicalSandboxId,
        phase: policy.phase,
        meta: evaluation.meta,
        status: response.status,
        durationMs: Math.max(0, now() - startedAt),
      }),
    );
    return response;
  } catch {
    const status = 502;
    logger.warn(
      buildAuditLog({
        decision: "allow",
        reason: "upstream_fetch_failed",
        sandboxId: ctx.containerId,
        logicalSandboxId,
        phase: policy.phase,
        meta: evaluation.meta,
        status,
        durationMs: Math.max(0, now() - startedAt),
      }),
    );
    return new Response("Upstream request failed", { status });
  }
}

/** 転送用の新規 Request を構築する（不変ヘッダ回避・ホップバイホップ/機密ヘッダ除去・redirect: manual）。 */
export function buildUpstreamRequest(
  original: Request,
  meta: EvaluatedRequestMeta,
  injectedAuthorization?: string,
): Request {
  const headers = sanitizeForwardHeaders(original.headers);
  if (injectedAuthorization !== undefined) {
    headers.set("Authorization", injectedAuthorization);
  }
  const cleanUrl = `https://${meta.host}${meta.rawPathname}${meta.rawSearch}`;
  const hasBody = meta.method !== "GET" && meta.method !== "HEAD";
  const init: RequestInit & { duplex?: "half" } = {
    method: meta.method,
    headers,
    redirect: "manual",
  };
  if (hasBody && original.body !== null) {
    init.body = original.body;
    init.duplex = "half";
  }
  return new Request(cleanUrl, init);
}

function evaluateCheckoutPolicy(
  meta: EvaluatedRequestMeta,
  params: CheckoutEgressParams | undefined,
  nowMs: number,
): EgressEvaluation {
  if (
    !params ||
    typeof params.repository !== "string" ||
    !SAFE_REPOSITORY_PATTERN.test(params.repository) ||
    params.repository.includes("..") ||
    typeof params.expiresAt !== "number" ||
    !Number.isFinite(params.expiresAt)
  ) {
    return { decision: "deny", reason: "invalid_policy_params", meta };
  }

  if (nowMs > params.expiresAt) {
    return { decision: "deny", reason: "policy_expired", meta };
  }

  if (meta.host !== CHECKOUT_ALLOWED_HOST) {
    return { decision: "deny", reason: "host_not_allowed", meta };
  }

  // checkout パスではエンコード文字 (%) や重複スラッシュ (//) を一切許可しない
  if (meta.rawPathname.includes("%") || meta.rawPathname.includes("//")) {
    return { decision: "deny", reason: "path_not_allowed", meta };
  }

  const normalizedRepo = params.repository.toLowerCase();
  const repoGitPath = `/${normalizedRepo}.git`;
  const lowerPath = meta.rawPathname.toLowerCase();

  if (lowerPath === `${repoGitPath}/info/refs`) {
    if (meta.method !== "GET") {
      return { decision: "deny", reason: "method_not_allowed", meta };
    }
    if (meta.rawSearch !== "?service=git-upload-pack") {
      return { decision: "deny", reason: "path_not_allowed", meta };
    }
    return {
      decision: "allow",
      reason: "allowed_checkout_refs",
      meta,
      normalizedRepository: normalizedRepo,
      ...(params.tokenId !== undefined ? { tokenId: params.tokenId } : {}),
    };
  }

  if (lowerPath === `${repoGitPath}/git-upload-pack`) {
    if (meta.method !== "POST") {
      return { decision: "deny", reason: "method_not_allowed", meta };
    }
    if (meta.rawSearch !== "") {
      return { decision: "deny", reason: "path_not_allowed", meta };
    }
    return {
      decision: "allow",
      reason: "allowed_checkout_upload_pack",
      meta,
      normalizedRepository: normalizedRepo,
      ...(params.tokenId !== undefined ? { tokenId: params.tokenId } : {}),
    };
  }

  return { decision: "deny", reason: "path_not_allowed", meta };
}

function evaluateInstallPolicy(
  meta: EvaluatedRequestMeta,
  params: InstallEgressParams | undefined,
  nowMs: number,
  extraInstallHosts: readonly string[],
): EgressEvaluation {
  if (!params || typeof params.expiresAt !== "number" || !Number.isFinite(params.expiresAt)) {
    return { decision: "deny", reason: "invalid_policy_params", meta };
  }

  if (nowMs > params.expiresAt) {
    return { decision: "deny", reason: "policy_expired", meta };
  }

  if (meta.method !== "GET" && meta.method !== "HEAD") {
    return { decision: "deny", reason: "method_not_allowed", meta };
  }

  const allowedHosts = new Set<string>([...DEFAULT_INSTALL_ALLOWED_HOSTS, ...extraInstallHosts]);
  if (!allowedHosts.has(meta.host)) {
    return { decision: "deny", reason: "host_not_allowed", meta };
  }

  return {
    decision: "allow",
    reason: "allowed_install_registry",
    meta,
  };
}

function matchesHostHeader(hostHeader: string | null, expectedHostname: string): boolean {
  if (hostHeader === null) {
    return true;
  }
  const trimmed = hostHeader.trim().toLowerCase();
  if (trimmed.length === 0) {
    return false;
  }
  const normalized = trimmed.endsWith(":443") ? trimmed.slice(0, -":443".length) : trimmed;
  return normalized === expectedHostname;
}

function extractRawPath(rawUrl: string): string {
  const schemeEnd = rawUrl.indexOf("://");
  const afterScheme = schemeEnd === -1 ? rawUrl : rawUrl.slice(schemeEnd + 3);
  const firstDelimiter = afterScheme.search(/[\\/?#]/);
  if (firstDelimiter === -1) {
    return "";
  }
  const delimiterChar = afterScheme[firstDelimiter];
  if (delimiterChar === "?" || delimiterChar === "#") {
    return "";
  }
  const pathWithRest = afterScheme.slice(firstDelimiter);
  const queryIndex = pathWithRest.indexOf("?");
  const hashIndex = pathWithRest.indexOf("#");
  const end =
    queryIndex === -1 ? hashIndex : hashIndex === -1 ? queryIndex : Math.min(queryIndex, hashIndex);
  return end === -1 ? pathWithRest : pathWithRest.slice(0, end);
}

function hasUnsafePathCharactersOrTraversal(pathname: string): boolean {
  if (hasControlCharacters(pathname) || pathname.includes("\\")) {
    return true;
  }
  if (/%00|%0a|%0d|%5c/i.test(pathname)) {
    return true;
  }
  // "/" およびエンコード済みスラッシュ "%2f" の両方で区切って ".." / "." セグメントを検査する
  // （scoped パッケージ "/@types%2fnode" は許可しつつ "/@types%2f..%2fsecret" は遮断する）
  const segments = pathname.split(/\/|%2f/i);
  for (const segment of segments) {
    const dotNormalized = segment.replace(/%2e/gi, ".");
    if (dotNormalized === "." || dotNormalized === "..") {
      return true;
    }
  }
  return false;
}

function sanitizeForwardHeaders(original: Headers): Headers {
  const dynamicHopByHop = new Set<string>();
  const connectionHeader = original.get("connection");
  if (connectionHeader !== null) {
    for (const token of connectionHeader.split(",")) {
      const normalized = token.trim().toLowerCase();
      if (normalized.length > 0) {
        dynamicHopByHop.add(normalized);
      }
    }
  }

  const sanitized = new Headers();
  original.forEach((value, key) => {
    const lowerKey = key.toLowerCase();
    if (STRIPPED_FORWARD_HEADERS.has(lowerKey) || dynamicHopByHop.has(lowerKey)) {
      return;
    }
    sanitized.append(key, value);
  });
  return sanitized;
}

function sanitizeAuditPath(pathname: string): {
  readonly path: string;
  readonly truncated: boolean;
} {
  let cleaned = "";
  for (let i = 0; i < pathname.length; i++) {
    const code = pathname.charCodeAt(i);
    if (code >= 0x20 && code !== 0x7f) {
      cleaned += pathname[i];
    }
  }
  if (cleaned.length <= MAX_AUDIT_PATH_LENGTH) {
    return { path: cleaned, truncated: false };
  }
  return { path: cleaned.slice(0, MAX_AUDIT_PATH_LENGTH), truncated: true };
}

function hasControlCharacters(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function resolvePortNumber(url: URL): number | null {
  if (url.port !== "") {
    const parsed = Number.parseInt(url.port, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (url.protocol === "https:") {
    return 443;
  }
  if (url.protocol === "http:") {
    return 80;
  }
  return null;
}

function buildAuditLog(input: {
  readonly decision: "allow" | "deny";
  readonly reason: string;
  readonly sandboxId: string;
  readonly logicalSandboxId?: string | undefined;
  readonly phase: EgressPhase;
  readonly meta: EvaluatedRequestMeta;
  readonly status: number;
  readonly durationMs: number;
}): EgressAuditLog {
  return {
    event: "sandbox.egress",
    decision: input.decision,
    reason: input.reason,
    sandboxId: input.sandboxId,
    ...(input.logicalSandboxId !== undefined ? { logicalSandboxId: input.logicalSandboxId } : {}),
    phase: input.phase,
    method: input.meta.method,
    protocol: input.meta.protocol,
    host: input.meta.host,
    port: input.meta.port,
    path: input.meta.auditPath,
    pathTruncated: input.meta.pathTruncated,
    status: input.status,
    durationMs: input.durationMs,
  };
}

function denyRuntime(
  logger: EgressLogger,
  reason: EgressDenyReason,
  sandboxId: string,
  logicalSandboxId: string | undefined,
  phase: EgressPhase,
  meta: EvaluatedRequestMeta,
  durationMs: number,
): Response {
  const status = 403;
  logger.warn(
    buildAuditLog({
      decision: "deny",
      reason,
      sandboxId,
      logicalSandboxId,
      phase,
      meta,
      status,
      durationMs,
    }),
  );
  return new Response(`Forbidden by sandbox egress policy: ${reason}`, { status });
}
