import { describe, expect, it, vi } from "vitest";

import {
  buildUpstreamRequest,
  type EgressAuditLog,
  type EgressLogger,
  evaluateEgressRequest,
  handleOutboundRequest,
  isPrivateOrInternalHost,
  isValidPublicFqdn,
  parseExtraAllowedHosts,
} from "./egress.js";

const NOW = 1_700_000_000_000;
const FUTURE = NOW + 60_000;
const PAST = NOW - 1;
const CTX = { containerId: "a".repeat(64) };

function createSpyLogger(): {
  logger: EgressLogger;
  infos: EgressAuditLog[];
  warns: EgressAuditLog[];
} {
  const infos: EgressAuditLog[] = [];
  const warns: EgressAuditLog[] = [];
  return {
    logger: {
      info: (entry) => infos.push(entry),
      warn: (entry) => warns.push(entry),
    },
    infos,
    warns,
  };
}

function rawRequest(
  url: string,
  init: { method?: string; headers?: Record<string, string> } = {},
): Request {
  return {
    url,
    method: init.method ?? "GET",
    headers: new Headers(init.headers),
    body: null,
  } as unknown as Request;
}

describe("parseExtraAllowedHosts / FQDN validation", () => {
  it("空文字や undefined は空配列を返し、正常な公開 FQDN を小文字正規化・重複排除する", () => {
    expect(parseExtraAllowedHosts(undefined)).toEqual([]);
    expect(parseExtraAllowedHosts("   ")).toEqual([]);
    expect(
      parseExtraAllowedHosts(" NPM.Example.COM , artifacts.corp.example, npm.example.com "),
    ).toEqual(["npm.example.com", "artifacts.corp.example"]);
  });

  it.each([
    "localhost",
    "sub.localhost",
    "printer.local",
    "r2.internal",
    "1.168.192.in-addr.arpa",
    "127.0.0.1",
    "169.254.169.254",
    "[::1]",
    "::1",
    "2130706433",
    "0x7f000001",
    "0177.0.0.1",
    "*.npmjs.org",
    "registry.npmjs.org.",
    ".registry.npmjs.org",
    "https://registry.npmjs.org",
    "registry.npmjs.org:443",
    "registry.npmjs.org/path",
    "intranet",
  ])("不正・内部・IP ホスト %s を拒否して例外を投げる", (invalid) => {
    expect(isValidPublicFqdn(invalid.toLowerCase())).toBe(false);
    expect(() => parseExtraAllowedHosts(invalid)).toThrow(/invalid hostname/);
  });

  it("プライベート・内部・IP 判定が期待通り動作する", () => {
    expect(isPrivateOrInternalHost("localhost")).toBe(true);
    expect(isPrivateOrInternalHost("s3-credential-proxy.internal")).toBe(true);
    expect(isPrivateOrInternalHost("169.254.169.254")).toBe(true);
    expect(isPrivateOrInternalHost("[::1]")).toBe(true);
    expect(isPrivateOrInternalHost("registry.npmjs.org")).toBe(false);
  });
});

describe("evaluateEgressRequest", () => {
  describe("locked フェーズ", () => {
    it("github.com や registry.npmjs.org を含むすべての通信を phase_locked で拒否する", () => {
      for (const url of [
        "https://github.com/octo/repo.git/info/refs?service=git-upload-pack",
        "https://registry.npmjs.org/vitest",
        "https://example.com/exfil",
        "http://example.com/",
      ]) {
        const result = evaluateEgressRequest(new Request(url), { phase: "locked" }, { nowMs: NOW });
        expect(result.decision).toBe("deny");
        if (result.decision === "deny") {
          expect(result.reason).toBe("phase_locked");
        }
      }
    });
  });

  describe("共通セキュリティ検査（Abuse Cases）", () => {
    const installPolicy = { phase: "install" as const, params: { expiresAt: FUTURE } };

    it("平文 HTTP は全許可フェーズで拒否する", () => {
      const result = evaluateEgressRequest(
        new Request("http://registry.npmjs.org/vitest"),
        installPolicy,
        { nowMs: NOW },
      );
      expect(result).toMatchObject({ decision: "deny", reason: "insecure_scheme" });
    });

    it("443 以外のポートは拒否し、明示的な :443 は正規化されて許可される", () => {
      const denied = evaluateEgressRequest(
        new Request("https://registry.npmjs.org:8443/vitest"),
        installPolicy,
        { nowMs: NOW },
      );
      expect(denied).toMatchObject({ decision: "deny", reason: "port_not_allowed" });

      const allowed = evaluateEgressRequest(
        new Request("https://registry.npmjs.org:443/vitest"),
        installPolicy,
        { nowMs: NOW },
      );
      expect(allowed).toMatchObject({ decision: "allow", reason: "allowed_install_registry" });
    });

    it("userinfo 付き URL を拒否する", () => {
      const result = evaluateEgressRequest(
        rawRequest("https://user:secret@registry.npmjs.org/vitest"),
        installPolicy,
        { nowMs: NOW },
      );
      expect(result).toMatchObject({ decision: "deny", reason: "userinfo_not_allowed" });
    });

    it("末尾ドット付きホスト名を拒否する", () => {
      const result = evaluateEgressRequest(
        new Request("https://registry.npmjs.org./vitest"),
        installPolicy,
        { nowMs: NOW },
      );
      expect(result).toMatchObject({ decision: "deny", reason: "invalid_hostname" });
    });

    it("IP リテラル・localhost・内部ドメインを拒否する", () => {
      for (const url of [
        "https://127.0.0.1/",
        "https://169.254.169.254/latest/meta-data/",
        "https://[::1]/",
        "https://2130706433/",
        "https://localhost/",
        "https://r2.internal/bucket",
        "https://service.local/",
      ]) {
        const result = evaluateEgressRequest(new Request(url), installPolicy, { nowMs: NOW });
        expect(result).toMatchObject({ decision: "deny", reason: "private_host_denied" });
      }
    });

    it("Host ヘッダが URL ホスト名と不一致なら拒否する", () => {
      const mismatch = evaluateEgressRequest(
        new Request("https://registry.npmjs.org/vitest", {
          headers: { host: "evil.example.com" },
        }),
        installPolicy,
        { nowMs: NOW },
      );
      expect(mismatch).toMatchObject({ decision: "deny", reason: "host_header_mismatch" });

      const portMismatch = evaluateEgressRequest(
        new Request("https://registry.npmjs.org/vitest", {
          headers: { host: "registry.npmjs.org:8443" },
        }),
        installPolicy,
        { nowMs: NOW },
      );
      expect(portMismatch).toMatchObject({ decision: "deny", reason: "host_header_mismatch" });

      const matchingWith443 = evaluateEgressRequest(
        new Request("https://registry.npmjs.org/vitest", {
          headers: { host: "REGISTRY.NPMJS.ORG:443" },
        }),
        installPolicy,
        { nowMs: NOW },
      );
      expect(matchingWith443).toMatchObject({ decision: "allow" });

      const emptyHost = evaluateEgressRequest(
        rawRequest("https://registry.npmjs.org/vitest", { headers: { host: "   " } }),
        installPolicy,
        { nowMs: NOW },
      );
      expect(emptyHost).toMatchObject({ decision: "deny", reason: "host_header_mismatch" });
    });

    it("CONNECT メソッドや Upgrade: websocket ヘッダ付きリクエストを拒否する", () => {
      const connectReq = evaluateEgressRequest(
        rawRequest("https://registry.npmjs.org/", { method: "CONNECT" }),
        installPolicy,
        { nowMs: NOW },
      );
      expect(connectReq).toMatchObject({ decision: "deny", reason: "method_not_allowed" });

      const result = evaluateEgressRequest(
        new Request("https://registry.npmjs.org/vitest", {
          headers: { upgrade: "websocket" },
        }),
        installPolicy,
        { nowMs: NOW },
      );
      expect(result).toMatchObject({ decision: "deny", reason: "upgrade_not_allowed" });
    });

    it("エンコード済みパストラバーサルや制御文字・バックスラッシュを拒否し、クエリ内の /../ は誤拒否しない", () => {
      for (const url of [
        "https://registry.npmjs.org/pkg/%2e%2e/secret",
        "https://registry.npmjs.org/@types%2f..%2fsecret",
        "https://registry.npmjs.org/%2e%2e%2fsecret",
        "https://registry.npmjs.org/pkg%00.tgz",
        "https://registry.npmjs.org/pkg%5csecret",
        "https://registry.npmjs.org\\@evil.com/pkg",
        "https://registry.npmjs.org/pkg\r\nInjected: 1",
      ]) {
        const result = evaluateEgressRequest(rawRequest(url), installPolicy, { nowMs: NOW });
        expect(result, url).toMatchObject({ decision: "deny", reason: "path_not_allowed" });
      }

      const queryWithSlash = evaluateEgressRequest(
        rawRequest("https://registry.npmjs.org?next=/../a"),
        installPolicy,
        { nowMs: NOW },
      );
      expect(queryWithSlash).toMatchObject({
        decision: "allow",
        reason: "allowed_install_registry",
      });
    });

    it("checkout / install で不正なポリシーパラメータ (repository や expiresAt) は invalid_policy_params で拒否する", () => {
      const badRepo = evaluateEgressRequest(
        new Request("https://github.com/octo/repo.git/info/refs?service=git-upload-pack"),
        { phase: "checkout", params: { repository: "../evil", expiresAt: FUTURE } },
        { nowMs: NOW },
      );
      expect(badRepo).toMatchObject({ decision: "deny", reason: "invalid_policy_params" });

      const nanExpiry = evaluateEgressRequest(
        new Request("https://registry.npmjs.org/vitest"),
        { phase: "install", params: { expiresAt: Number.NaN } },
        { nowMs: NOW },
      );
      expect(nanExpiry).toMatchObject({ decision: "deny", reason: "invalid_policy_params" });
    });
  });

  describe("checkout フェーズ", () => {
    const checkoutPolicy = {
      phase: "checkout" as const,
      params: { repository: "Octo/Repo", tokenId: "tok-1", expiresAt: FUTURE },
    };

    it("対象リポジトリの git-upload-pack (GET info/refs と POST git-upload-pack) のみ許可し、大文字小文字を吸収する", () => {
      const refs = evaluateEgressRequest(
        new Request("https://github.com/octo/repo.git/info/refs?service=git-upload-pack"),
        checkoutPolicy,
        { nowMs: NOW },
      );
      expect(refs).toMatchObject({
        decision: "allow",
        reason: "allowed_checkout_refs",
        normalizedRepository: "octo/repo",
        tokenId: "tok-1",
      });

      const pack = evaluateEgressRequest(
        new Request("https://github.com/Octo/Repo.git/git-upload-pack", { method: "POST" }),
        checkoutPolicy,
        { nowMs: NOW },
      );
      expect(pack).toMatchObject({
        decision: "allow",
        reason: "allowed_checkout_upload_pack",
        normalizedRepository: "octo/repo",
        tokenId: "tok-1",
      });
    });

    it("別リポジトリ・git-receive-pack・不正クエリ・エンコード文字・api.github.com・期限切れをすべて拒否する", () => {
      const deniedCases: Array<{ req: Request; expectedReason: string }> = [
        {
          req: new Request("https://github.com/octo/other.git/info/refs?service=git-upload-pack"),
          expectedReason: "path_not_allowed",
        },
        {
          req: new Request(
            "https://github.com/octo/repo.git/%2e%2e/%2e%2e/octo/other.git/info/refs?service=git-upload-pack",
          ),
          expectedReason: "path_not_allowed",
        },
        {
          req: new Request("https://github.com/octo/repo.git/info/refs?service=git-receive-pack"),
          expectedReason: "path_not_allowed",
        },
        {
          req: new Request(
            "https://github.com/octo/repo.git/info/refs?service=git-upload-pack&exfil=1",
          ),
          expectedReason: "path_not_allowed",
        },
        {
          req: new Request("https://github.com/octo/repo.git/info/refs?service=git-upload-pack", {
            method: "POST",
          }),
          expectedReason: "method_not_allowed",
        },
        {
          req: new Request("https://github.com/octo/repo.git/git-upload-pack", { method: "GET" }),
          expectedReason: "method_not_allowed",
        },
        {
          req: new Request("https://github.com/octo/repo.git/git-upload-pack?extra=1", {
            method: "POST",
          }),
          expectedReason: "path_not_allowed",
        },
        {
          req: new Request("https://github.com/octo/repo.git/git-receive-pack", { method: "POST" }),
          expectedReason: "path_not_allowed",
        },
        {
          req: new Request("https://github.com//octo/repo.git/info/refs?service=git-upload-pack"),
          expectedReason: "path_not_allowed",
        },
        {
          req: new Request("https://api.github.com/repos/octo/repo"),
          expectedReason: "host_not_allowed",
        },
        {
          req: new Request("https://registry.npmjs.org/vitest"),
          expectedReason: "host_not_allowed",
        },
      ];

      for (const { req, expectedReason } of deniedCases) {
        const res = evaluateEgressRequest(req, checkoutPolicy, { nowMs: NOW });
        expect(res, req.url).toMatchObject({ decision: "deny", reason: expectedReason });
      }

      const expired = evaluateEgressRequest(
        new Request("https://github.com/octo/repo.git/info/refs?service=git-upload-pack"),
        { phase: "checkout", params: { repository: "octo/repo", expiresAt: PAST } },
        { nowMs: NOW },
      );
      expect(expired).toMatchObject({ decision: "deny", reason: "policy_expired" });
    });
  });

  describe("install フェーズ", () => {
    const installPolicy = { phase: "install" as const, params: { expiresAt: FUTURE } };

    it("既定レジストリおよび追加ホストへの GET/HEAD と scoped パッケージ (%2f) を許可する", () => {
      for (const url of [
        "https://registry.npmjs.org/@types%2fnode",
        "https://registry.npmjs.org/vitest/-/vitest-4.1.0.tgz",
        "https://registry.yarnpkg.com/lodash",
        "https://repo.yarnpkg.com/4.5.0/packages/yarnpkg-cli/bin/yarn.js",
        "https://npm.corp.example/@corp%2fpkg",
      ]) {
        const res = evaluateEgressRequest(new Request(url, { method: "GET" }), installPolicy, {
          nowMs: NOW,
          extraInstallHosts: ["npm.corp.example"],
        });
        expect(res, url).toMatchObject({ decision: "allow", reason: "allowed_install_registry" });
      }

      const head = evaluateEgressRequest(
        new Request("https://registry.npmjs.org/vitest", { method: "HEAD" }),
        installPolicy,
        { nowMs: NOW },
      );
      expect(head).toMatchObject({ decision: "allow" });
    });

    it("POST/PUT、未許可ホスト（github.com や DoH 含む）、TTL 期限切れを拒否する", () => {
      const postAudit = evaluateEgressRequest(
        new Request("https://registry.npmjs.org/-/npm/v1/security/audits/quick", {
          method: "POST",
        }),
        installPolicy,
        { nowMs: NOW },
      );
      expect(postAudit).toMatchObject({ decision: "deny", reason: "method_not_allowed" });

      for (const url of [
        "https://github.com/octo/repo.git/info/refs?service=git-upload-pack",
        "https://evil.example.com/exfil",
        "https://dns.google/dns-query",
        "https://cloudflare-dns.com/dns-query",
      ]) {
        const res = evaluateEgressRequest(new Request(url), installPolicy, { nowMs: NOW });
        expect(res, url).toMatchObject({ decision: "deny", reason: "host_not_allowed" });
      }

      const expired = evaluateEgressRequest(
        new Request("https://registry.npmjs.org/vitest"),
        { phase: "install", params: { expiresAt: PAST } },
        { nowMs: NOW },
      );
      expect(expired).toMatchObject({ decision: "deny", reason: "policy_expired" });
    });
  });
});

describe("buildUpstreamRequest / handleOutboundRequest", () => {
  it("redirect: manual を設定し、Host・ホップバイホップ・Cookie・コンテナ由来の Authorization を除去する", () => {
    const req = new Request("https://registry.npmjs.org/vitest?foo=bar", {
      method: "GET",
      headers: {
        accept: "application/json",
        host: "registry.npmjs.org:443",
        authorization: "Bearer container-spoofed-token",
        cookie: "session=secret",
        connection: "keep-alive, x-custom-hop",
        "x-custom-hop": "drop-me",
        "proxy-authorization": "Basic abc",
        "x-forwarded-for": "1.2.3.4",
      },
    });
    const evalRes = evaluateEgressRequest(
      req,
      { phase: "install", params: { expiresAt: FUTURE } },
      { nowMs: NOW },
    );
    expect(evalRes.decision).toBe("allow");
    if (evalRes.decision !== "allow") throw new Error("unreachable");

    const upstream = buildUpstreamRequest(req, evalRes.meta);
    expect(upstream.redirect).toBe("manual");
    expect(upstream.url).toBe("https://registry.npmjs.org/vitest?foo=bar");
    expect(upstream.headers.get("accept")).toBe("application/json");
    expect(upstream.headers.get("host")).toBeNull();
    expect(upstream.headers.get("authorization")).toBeNull();
    expect(upstream.headers.get("cookie")).toBeNull();
    expect(upstream.headers.get("connection")).toBeNull();
    expect(upstream.headers.get("x-custom-hop")).toBeNull();
    expect(upstream.headers.get("proxy-authorization")).toBeNull();
    expect(upstream.headers.get("x-forwarded-for")).toBeNull();
  });

  it("checkout フェーズでは Worker 側フックから取得した Authorization を注入し、監査ログに機密を一切出さない", async () => {
    const { logger, infos, warns } = createSpyLogger();
    const seenRequests: Request[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      seenRequests.push(input as Request);
      return new Response("001e# service=git-upload-pack\n0000", { status: 200 });
    });

    const response = await handleOutboundRequest(
      new Request("https://github.com/Octo/Repo.git/info/refs?service=git-upload-pack", {
        headers: {
          authorization: "Basic c3Bvb2ZlZA==",
          cookie: "gh_sess=secret",
          "user-agent": "git/2.45.0",
        },
      }),
      {
        phase: "checkout",
        params: {
          repository: "Octo/Repo",
          tokenId: "tok-abc",
          expiresAt: FUTURE,
          logicalSandboxId: "logical-sandbox-1",
        },
      },
      CTX,
      {
        fetchImpl: fetchMock as unknown as typeof fetch,
        logger,
        now: () => NOW,
        resolveCheckoutAuthorization: async (tokenId, repo) => {
          expect(tokenId).toBe("tok-abc");
          expect(repo).toBe("octo/repo");
          return "Basic Z2hzX3JlYWxfdG9rZW4=";
        },
      },
    );

    expect(response.status).toBe(200);
    expect(seenRequests).toHaveLength(1);
    expect(seenRequests[0]?.headers.get("authorization")).toBe("Basic Z2hzX3JlYWxfdG9rZW4=");
    expect(seenRequests[0]?.headers.get("cookie")).toBeNull();
    expect(seenRequests[0]?.redirect).toBe("manual");

    expect(warns).toEqual([]);
    expect(infos).toHaveLength(1);
    expect(infos[0]).toEqual({
      event: "sandbox.egress",
      decision: "allow",
      reason: "allowed_checkout_refs",
      sandboxId: CTX.containerId,
      logicalSandboxId: "logical-sandbox-1",
      phase: "checkout",
      method: "GET",
      protocol: "https:",
      host: "github.com",
      port: 443,
      path: "/Octo/Repo.git/info/refs",
      pathTruncated: false,
      status: 200,
      durationMs: 0,
    });
    const serializedLog = JSON.stringify(infos[0]);
    expect(serializedLog).not.toContain("Z2hzX3JlYWxfdG9rZW4");
    expect(serializedLog).not.toContain("c3Bvb2ZlZA");
    expect(serializedLog).not.toContain("gh_sess");
    expect(serializedLog).not.toContain("service=git-upload-pack");
  });

  it("checkout の POST /git-upload-pack ではリクエストボディを保ったまま転送し、認証ヘッダを注入する", async () => {
    const { logger, infos } = createSpyLogger();
    const seenBodies: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const req = input as Request;
      expect(req.method).toBe("POST");
      expect(req.headers.get("authorization")).toBe("Basic Z2hzX3Bvc3Q=");
      expect(req.headers.get("content-type")).toBe("application/x-git-upload-pack-request");
      seenBodies.push(await req.text());
      return new Response("pack-data", { status: 200 });
    });

    const response = await handleOutboundRequest(
      new Request("https://github.com/octo/repo.git/git-upload-pack", {
        method: "POST",
        headers: { "content-type": "application/x-git-upload-pack-request" },
        body: "0032want abc123\n0000",
      }),
      {
        phase: "checkout",
        params: { repository: "octo/repo", tokenId: "tok-post", expiresAt: FUTURE },
      },
      CTX,
      {
        fetchImpl: fetchMock as unknown as typeof fetch,
        logger,
        now: () => NOW,
        resolveCheckoutAuthorization: async () => "Basic Z2hzX3Bvc3Q=",
      },
    );

    expect(response.status).toBe(200);
    expect(seenBodies).toEqual(["0032want abc123\n0000"]);
    expect(infos[0]).toMatchObject({
      decision: "allow",
      reason: "allowed_checkout_upload_pack",
      method: "POST",
      status: 200,
    });
  });

  it("checkout でトークン解決が null または例外を投げた場合は fail-closed で 403 を返し fetch を呼ばない", async () => {
    const { logger, infos, warns } = createSpyLogger();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi.fn();

    const response = await handleOutboundRequest(
      new Request("https://github.com/octo/repo.git/info/refs?service=git-upload-pack"),
      {
        phase: "checkout",
        params: { repository: "octo/repo", tokenId: "tok-expired", expiresAt: FUTURE },
      },
      CTX,
      {
        fetchImpl: fetchMock as unknown as typeof fetch,
        logger,
        now: () => NOW,
        resolveCheckoutAuthorization: async () => null,
      },
    );

    const responseOnThrow = await handleOutboundRequest(
      new Request("https://github.com/octo/repo.git/info/refs?service=git-upload-pack"),
      {
        phase: "checkout",
        params: { repository: "octo/repo", tokenId: "tok-rpc-err", expiresAt: FUTURE },
      },
      CTX,
      {
        fetchImpl: fetchMock as unknown as typeof fetch,
        logger,
        now: () => NOW,
        resolveCheckoutAuthorization: async () => {
          throw new Error("DO RPC disconnected");
        },
      },
    );

    expect(response.status).toBe(403);
    expect(responseOnThrow.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(infos).toEqual([]);
    expect(warns).toHaveLength(2);
    expect(warns[0]).toMatchObject({
      decision: "deny",
      reason: "checkout_auth_unavailable",
      status: 403,
    });
    expect(warns[1]).toMatchObject({
      decision: "deny",
      reason: "checkout_auth_unavailable",
      status: 403,
    });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  it("上流の 302 リダイレクトは自動追従せずそのまま返却する", async () => {
    const { logger, infos } = createSpyLogger();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const req = input as Request;
      expect(req.redirect).toBe("manual");
      return new Response(null, {
        status: 302,
        headers: { location: "https://evil.example.com/steal" },
      });
    });

    const response = await handleOutboundRequest(
      new Request("https://registry.npmjs.org/pkg"),
      { phase: "install", params: { expiresAt: FUTURE } },
      CTX,
      { fetchImpl: fetchMock as unknown as typeof fetch, logger, now: () => NOW },
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://evil.example.com/steal");
    expect(infos[0]).toMatchObject({ decision: "allow", status: 302 });
  });

  it("拒否ログからクエリ・フラグメント・userinfo を除外し、長大パスは 256 文字で切り詰める", async () => {
    const { logger, warns } = createSpyLogger();
    const longPath = `/${"a".repeat(300)}`;
    const response = await handleOutboundRequest(
      rawRequest(
        `https://secret-user:secret-pass@evil.example.com${longPath}?token=SECRET_TOKEN#frag-secret`,
        {
          headers: { authorization: "Bearer SECRET_BEARER", cookie: "sid=SECRET_COOKIE" },
        },
      ),
      { phase: "locked" },
      CTX,
      { logger, now: () => NOW },
    );

    expect(response.status).toBe(403);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatchObject({
      event: "sandbox.egress",
      decision: "deny",
      reason: "phase_locked",
      host: "evil.example.com",
      path: longPath.slice(0, 256),
      pathTruncated: true,
      status: 403,
    });
    const serialized = JSON.stringify(warns[0]);
    expect(serialized).not.toContain("secret-user");
    expect(serialized).not.toContain("secret-pass");
    expect(serialized).not.toContain("SECRET_TOKEN");
    expect(serialized).not.toContain("frag-secret");
    expect(serialized).not.toContain("SECRET_BEARER");
    expect(serialized).not.toContain("SECRET_COOKIE");
  });

  it("上流 fetch が例外を投げた場合は 502 を返し、内部エラー詳細を漏らさず監査ログを記録する", async () => {
    const { logger, warns } = createSpyLogger();
    const fetchMock = vi.fn(async () => {
      throw new Error("internal socket failure: 10.0.0.1");
    });

    const response = await handleOutboundRequest(
      new Request("https://registry.npmjs.org/vitest"),
      { phase: "install", params: { expiresAt: FUTURE } },
      CTX,
      { fetchImpl: fetchMock as unknown as typeof fetch, logger, now: () => NOW },
    );

    expect(response.status).toBe(502);
    await expect(response.text()).resolves.toBe("Upstream request failed");
    expect(warns[0]).toMatchObject({
      decision: "allow",
      reason: "upstream_fetch_failed",
      status: 502,
    });
  });
});
