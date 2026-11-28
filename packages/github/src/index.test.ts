import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearInstallationTokenCache,
  createAppJwt,
  createPullRequestClient,
  createPullRequestReadClient,
  createPullRequestWriteClient,
  extractReviewFingerprint,
  GitHubApiError,
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

  it("repositories と permissions を指定すると JSON ボディで最小権限トークンを発行し、スコープ別にキャッシュを分離する", async () => {
    const calls: Array<{ body: string | undefined; contentType: string | undefined }> = [];
    const futureIso = new Date(Date.now() + 3600_000).toISOString();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        calls.push({
          body: typeof init?.body === "string" ? init.body : undefined,
          contentType: headers.get("Content-Type") ?? undefined,
        });
        return Response.json(
          { token: `ghs_scoped_${calls.length}`, expires_at: futureIso },
          { status: 201 },
        );
      }),
    );

    const credentials = { appId: "12345", privateKey: pkcs1Pem, installationId: 222 };
    const defaultToken = await issueInstallationToken(credentials);
    const readOnlyToken = await issueInstallationToken(credentials, {
      repositories: ["repo"],
      permissions: { contents: "read" },
    });
    const readOnlyCached = await issueInstallationToken(credentials, {
      repositories: [" repo ", "repo"],
      permissions: { contents: "read" },
    });
    const otherRepoToken = await issueInstallationToken(credentials, {
      repositories: ["other"],
      permissions: { contents: "read" },
    });
    const writeToken = await issueInstallationToken(credentials, {
      repositories: ["repo"],
      permissions: { contents: "write" },
    });

    expect(defaultToken).toBe("ghs_scoped_1");
    expect(readOnlyToken).toBe("ghs_scoped_2");
    expect(readOnlyCached).toBe("ghs_scoped_2");
    expect(otherRepoToken).toBe("ghs_scoped_3");
    expect(writeToken).toBe("ghs_scoped_4");
    expect(calls).toEqual([
      { body: undefined, contentType: undefined },
      {
        body: JSON.stringify({ repositories: ["repo"], permissions: { contents: "read" } }),
        contentType: "application/json",
      },
      {
        body: JSON.stringify({ repositories: ["other"], permissions: { contents: "read" } }),
        contentType: "application/json",
      },
      {
        body: JSON.stringify({ repositories: ["repo"], permissions: { contents: "write" } }),
        contentType: "application/json",
      },
    ]);
  });

  it("権限未承認（422）時は GITHUB_PERMISSION_DENIED の GitHubApiError を投げる", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ message: "The permissions requested are not granted" }), {
            status: 422,
          }),
      ),
    );
    const credentials = { appId: "12345", privateKey: pkcs1Pem, installationId: 444 };
    await expect(
      issueInstallationToken(credentials, {
        repositories: ["repo"],
        permissions: { checks: "read", statuses: "read" },
      }),
    ).rejects.toMatchObject({
      name: "GitHubApiError",
      code: "GITHUB_PERMISSION_DENIED",
      status: 422,
    });
  });

  it("repositories や permissions に不正な値を渡すと例外を投げる", async () => {
    const credentials = { appId: "12345", privateKey: pkcs1Pem, installationId: 333 };
    await expect(
      issueInstallationToken(credentials, { repositories: ["octo/repo"] }),
    ).rejects.toThrow(/invalid repository name/);
    await expect(issueInstallationToken(credentials, { repositories: ["."] })).rejects.toThrow(
      /invalid repository name/,
    );
    await expect(
      issueInstallationToken(credentials, { repositories: ["foo bar"] }),
    ).rejects.toThrow(/invalid repository name/);
    await expect(issueInstallationToken(credentials, { repositories: [] })).rejects.toThrow(
      /must not be empty/,
    );
    await expect(issueInstallationToken(credentials, { permissions: {} })).rejects.toThrow(
      /must not be empty/,
    );
    await expect(
      issueInstallationToken(credentials, {
        permissions: { contents: "admin" as unknown as "read" },
      }),
    ).rejects.toThrow(/invalid installation token permission/);
  });
});

describe("PullRequestReadClient / PullRequestWriteClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("Read クライアントには Write メソッドが存在せず、Read / Write で別トークンを利用できる", async () => {
    const auths: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const headers = new Headers(init?.headers);
        auths.push(`${init?.method}:${headers.get("Authorization")}`);
        if (url.endsWith("/pulls/7")) {
          return new Response("diff --git a/a.ts b/a.ts", { status: 200 });
        }
        if (url.endsWith("/pulls/7/reviews")) {
          return Response.json({ id: 99 }, { status: 200 });
        }
        return new Response("not found", { status: 404 });
      }),
    );

    const readClient = createPullRequestReadClient({
      repository: "octo/repo",
      pullNumber: 7,
      getToken: async () => "ghs_read_only",
    });
    const writeClient = createPullRequestWriteClient({
      repository: "octo/repo",
      pullNumber: 7,
      getToken: async () => "ghs_write_only",
    });

    expect("postReview" in readClient).toBe(false);
    expect("resolveThread" in readClient).toBe(false);

    await expect(readClient.getDiff()).resolves.toBe("diff --git a/a.ts b/a.ts");
    await expect(writeClient.postReview({ body: "ok" })).resolves.toEqual({ id: 99 });
    expect(auths).toEqual(["GET:Bearer ghs_read_only", "POST:Bearer ghs_write_only"]);
  });

  it("getPullRequestMeta が内部 PR・フォーク PR・削除済みフォーク・フォークリポ内内部 PR を正確に判定する", async () => {
    const responses = [
      // 1. 通常の内部 PR（fork: true のリポ内同士のブランチ PR でも同一 repo id/name なら isFork: false）
      {
        number: 7,
        state: "open",
        draft: false,
        title: "Add feature",
        body: "details",
        user: { login: "alice" },
        base: {
          sha: "base111",
          ref: "development",
          repo: { id: 100, full_name: "octo/repo", default_branch: "main", fork: true },
        },
        head: {
          sha: "head222",
          ref: "feat/x",
          repo: { id: 100, full_name: "octo/repo", default_branch: "main", fork: true },
        },
      },
      // 2. 外部フォーク PR
      {
        number: 7,
        state: "open",
        draft: true,
        title: "External PR",
        body: null,
        user: { login: "eve" },
        base: {
          sha: "base111",
          ref: "main",
          repo: { id: 100, full_name: "octo/repo", default_branch: "main" },
        },
        head: {
          sha: "head333",
          ref: "patch-1",
          repo: { id: 200, full_name: "eve/repo", default_branch: "main" },
        },
      },
      // 3. 削除済みフォーク PR (head.repo = null -> fail-closed で isFork: true)
      {
        number: 7,
        state: "open",
        draft: false,
        title: "Deleted fork PR",
        body: null,
        user: { login: "ghost" },
        base: {
          sha: "base111",
          ref: "main",
          repo: { id: 100, full_name: "octo/repo", default_branch: "main" },
        },
        head: { sha: "head444", ref: "patch-2", repo: null },
      },
    ];
    let index = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const body = responses[index];
        index += 1;
        return Response.json(body);
      }),
    );

    const client = createPullRequestReadClient({
      repository: "octo/repo",
      pullNumber: 7,
      getToken: async () => "ghs_token",
    });

    const internal = await client.getPullRequestMeta();
    expect(internal).toMatchObject({
      baseSha: "base111",
      headSha: "head222",
      defaultBranch: "main",
      draft: false,
      isFork: false,
      authorLogin: "alice",
    });

    const external = await client.getPullRequestMeta();
    expect(external).toMatchObject({
      draft: true,
      isFork: true,
      headRepoFullName: "eve/repo",
    });

    const deletedFork = await client.getPullRequestMeta();
    expect(deletedFork.isFork).toBe(true);
    expect(deletedFork.headRepoId).toBeNull();
  });

  it("getDiff が 3-dot PR diff・compare 増分 diff・406 上限超過エラーを正しく扱う", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        urls.push(url);
        if (url.endsWith("/pulls/7")) {
          return new Response("diff --git a/a.ts b/a.ts", { status: 200 });
        }
        if (url.endsWith("/compare/sha1...sha2")) {
          return new Response("diff --git a/b.ts b/b.ts", { status: 200 });
        }
        if (url.endsWith("/compare/sha1...huge")) {
          return new Response("diff exceeded maximum lines", { status: 406 });
        }
        return new Response("not found", { status: 404 });
      }),
    );

    const client = createPullRequestReadClient({
      repository: "octo/repo",
      pullNumber: 7,
      getToken: async () => "ghs_token",
    });

    await expect(client.getDiff()).resolves.toBe("diff --git a/a.ts b/a.ts");
    await expect(client.getDiff({ base: "sha1", head: "sha2" })).resolves.toBe(
      "diff --git a/b.ts b/b.ts",
    );
    await expect(client.getDiff({ base: "sha1", head: "huge" })).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof GitHubApiError && err.code === "GITHUB_DIFF_TOO_LARGE" && err.status === 406,
    );
    await expect(client.getDiff({ base: "../bad", head: "sha2" })).rejects.toThrow(/invalid/);
    expect(urls).toEqual([
      "https://api.github.com/repos/octo/repo/pulls/7",
      "https://api.github.com/repos/octo/repo/compare/sha1...sha2",
      "https://api.github.com/repos/octo/repo/compare/sha1...huge",
    ]);
  });

  it("getCommitChecks が Check Runs (再実行重複排除・selfAppId 除外・headSha 厳密一致・Annotations)・Check Suites・Commit Status を統合取得する", async () => {
    const annotationCalls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const auth = new Headers(init?.headers).get("Authorization");
        expect(auth).toBe("Bearer ghs_checks_token");

        if (url.includes("/commits/head123/check-runs") && !url.includes("page=2")) {
          return new Response(
            JSON.stringify({
              check_runs: [
                // 自身の App ID (999) -> 除外される
                {
                  id: 1,
                  name: "PR Review Harness",
                  head_sha: "head123",
                  status: "in_progress",
                  conclusion: null,
                  app: { id: 999, slug: "self-app" },
                },
                // headSha 不一致 -> 除外される
                {
                  id: 2,
                  name: "unit-tests",
                  head_sha: "other-sha",
                  status: "completed",
                  conclusion: "failure",
                  app: { id: 10, slug: "github-actions" },
                },
                // 古い失敗実行（id=10）
                {
                  id: 10,
                  name: "unit-tests",
                  head_sha: "head123",
                  status: "completed",
                  conclusion: "failure",
                  app: { id: 10, slug: "github-actions" },
                },
                // 同じ名前の新しい成功再実行（id=20） -> id=10 を上書き
                {
                  id: 20,
                  name: "unit-tests",
                  head_sha: "head123",
                  status: "completed",
                  conclusion: "success",
                  app: { id: 10, slug: "github-actions" },
                  output: { title: "All passed", summary: "10 passed", annotations_count: 0 },
                },
              ],
            }),
            {
              status: 200,
              headers: {
                "Content-Type": "application/json",
                Link: '<https://api.github.com/repos/octo/repo/commits/head123/check-runs?filter=latest&per_page=100&page=2>; rel="next"',
              },
            },
          );
        }
        if (url.includes("/commits/head123/check-runs") && url.includes("page=2")) {
          return Response.json({
            check_runs: [
              {
                id: 30,
                name: "integration-test",
                head_sha: "head123",
                status: "completed",
                conclusion: "failure",
                app: { id: 10, slug: "github-actions" },
                output: { title: "1 failed", summary: "boom", annotations_count: 1 },
              },
            ],
          });
        }
        if (url.includes("/check-runs/30/annotations")) {
          annotationCalls.push(url);
          return Response.json([
            {
              path: "src/sum.ts",
              start_line: 12,
              end_line: 12,
              annotation_level: "failure",
              title: "AssertionError",
              message: "expected 3 to be 4",
            },
          ]);
        }
        if (url.includes("/commits/head123/check-suites")) {
          return Response.json({
            check_suites: [
              {
                id: 500,
                head_sha: "head123",
                status: "completed",
                conclusion: "failure",
                app: { id: 10, slug: "github-actions" },
              },
              {
                id: 501,
                head_sha: "head123",
                status: "queued",
                conclusion: null,
                app: { id: 999, slug: "self-app" },
              },
            ],
          });
        }
        if (url.includes("/commits/head123/status")) {
          return Response.json({
            sha: "head123",
            state: "failure",
            statuses: [
              {
                id: 700,
                context: "ci/build",
                state: "error",
                description: "build crashed",
                target_url: "https://ci.example/1",
                updated_at: "2026-11-28T00:00:00Z",
              },
            ],
          });
        }
        return new Response(`unexpected ${url}`, { status: 404 });
      }),
    );

    const client = createPullRequestReadClient({
      repository: "octo/repo",
      pullNumber: 7,
      getToken: async () => "ghs_repo_token",
      getChecksToken: async () => "ghs_checks_token",
      selfAppId: "999",
    });

    const snapshot = await client.getCommitChecks("head123");
    expect(snapshot.headSha).toBe("head123");
    expect(snapshot.truncated).toBe(false);
    expect(snapshot.checkSuites).toEqual([
      {
        id: 500,
        appId: 10,
        appSlug: "github-actions",
        status: "completed",
        conclusion: "failure",
      },
    ]);
    expect(snapshot.checks).toEqual([
      expect.objectContaining({
        source: "check_run",
        id: 20,
        name: "unit-tests",
        status: "completed",
        conclusion: "success",
        annotations: [],
      }),
      expect.objectContaining({
        source: "check_run",
        id: 30,
        name: "integration-test",
        status: "completed",
        conclusion: "failure",
        annotations: [
          {
            path: "src/sum.ts",
            startLine: 12,
            endLine: 12,
            annotationLevel: "failure",
            title: "AssertionError",
            message: "expected 3 to be 4",
          },
        ],
      }),
      expect.objectContaining({
        source: "commit_status",
        name: "ci/build",
        status: "completed",
        conclusion: "error",
        summary: "build crashed",
      }),
    ]);
    expect(annotationCalls).toHaveLength(1);
  });

  it("getCommitChecks が selfStatusContextPrefix を除外し、check-suites の複数ページと truncated を伝播する", async () => {
    let suitePages = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("/commits/head456/check-runs")) {
          return Response.json({ check_runs: [] });
        }
        if (url.includes("/commits/head456/check-suites")) {
          suitePages += 1;
          const headers: Record<string, string> = { "Content-Type": "application/json" };
          // MAX_CHECK_RUN_PAGES (5) を超える Link を返し続ける -> truncated: true
          headers.Link = `<https://api.github.com/repos/octo/repo/commits/head456/check-suites?per_page=100&page=${suitePages + 1}>; rel="next"`;
          return new Response(
            JSON.stringify({
              check_suites: [
                {
                  id: 1000 + suitePages,
                  head_sha: "head456",
                  status: "completed",
                  conclusion: "success",
                  app: { id: 10, slug: "github-actions" },
                },
              ],
            }),
            { status: 200, headers },
          );
        }
        if (url.includes("/commits/head456/status")) {
          return Response.json({
            sha: "head456",
            state: "success",
            statuses: [
              { id: 1, context: "review-harness/self", state: "pending", description: "running" },
              { id: 2, context: "ci/unit-test", state: "success", description: "all green" },
            ],
          });
        }
        return new Response("not found", { status: 404 });
      }),
    );

    const client = createPullRequestReadClient({
      repository: "octo/repo",
      pullNumber: 7,
      getToken: async () => "ghs_token",
      selfStatusContextPrefix: "review-harness/",
    });

    const snapshot = await client.getCommitChecks("head456");
    expect(suitePages).toBe(5);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.checkSuites).toHaveLength(5);
    expect(snapshot.checks.map((c) => c.name)).toEqual(["ci/unit-test"]);
  });

  it("listReviewThreads が GraphQL ページネーションと不可視 fingerprint マーカー抽出を行う", async () => {
    let callCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        callCount += 1;
        const body = JSON.parse(String(init?.body)) as { variables: { cursor: string | null } };
        if (body.variables.cursor === null) {
          return Response.json({
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
                    nodes: [
                      {
                        id: "PRRT_1",
                        isResolved: false,
                        isOutdated: false,
                        path: "src/a.ts",
                        line: 10,
                        originalLine: 10,
                        startLine: null,
                        diffSide: "RIGHT",
                        comments: {
                          nodes: [
                            {
                              id: "PRRC_1",
                              body: "バグがあります\n<!-- review-harness:fp=fp_abc123 -->",
                              author: { login: "bot" },
                              createdAt: "2026-11-28T00:00:00Z",
                              url: "https://github.com/octo/repo/pull/7#discussion_r1",
                            },
                          ],
                        },
                      },
                    ],
                  },
                },
              },
            },
          });
        }
        return Response.json({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: "PRRT_2",
                      isResolved: true,
                      isOutdated: true,
                      path: "src/b.ts",
                      line: null,
                      originalLine: 5,
                      startLine: null,
                      diffSide: "RIGHT",
                      comments: {
                        nodes: [
                          {
                            id: "PRRC_2",
                            body: "人間コメント",
                            author: { login: "alice" },
                            createdAt: "2026-11-28T00:01:00Z",
                            url: "https://github.com/octo/repo/pull/7#discussion_r2",
                          },
                        ],
                      },
                    },
                  ],
                },
              },
            },
          },
        });
      }),
    );

    const client = createPullRequestReadClient({
      repository: "octo/repo",
      pullNumber: 7,
      getToken: async () => "ghs_token",
    });

    const result = await client.listReviewThreads();
    expect(callCount).toBe(2);
    expect(result.truncated).toBe(false);
    expect(result.threads).toHaveLength(2);
    expect(result.threads[0]).toMatchObject({
      id: "PRRT_1",
      isResolved: false,
      path: "src/a.ts",
      line: 10,
      fingerprint: "fp_abc123",
    });
    expect(result.threads[1]).toMatchObject({
      id: "PRRT_2",
      isResolved: true,
      fingerprint: null,
    });
    expect(extractReviewFingerprint("<!-- review-harness:fp=sha256:9a1b -->")).toBe("sha256:9a1b");
  });

  it("getFileContent が UTF-8 日本語 base64（改行付き）をデコードし、404 は null、symlink/パストラバーサル/サイズ超過を拒否する", async () => {
    const japaneseText = "# レビュー規約\n型安全を徹底すること。\n";
    const encodedWithNewlines = Buffer.from(japaneseText, "utf-8")
      .toString("base64")
      .replace(/(.{16})/g, "$1\n");

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("/contents/REVIEW.md?ref=main")) {
          return Response.json({
            type: "file",
            encoding: "base64",
            size: Buffer.byteLength(japaneseText, "utf-8"),
            content: encodedWithNewlines,
          });
        }
        if (url.includes("/contents/missing.json?ref=main")) {
          return new Response("Not Found", { status: 404 });
        }
        if (url.includes("/contents/evil-link?ref=main")) {
          return Response.json({ type: "symlink", target: "/etc/passwd" });
        }
        if (url.includes("/contents/huge.txt?ref=main")) {
          return Response.json({
            type: "file",
            encoding: "base64",
            size: 1_000_000,
            content: "",
          });
        }
        return new Response("unexpected", { status: 500 });
      }),
    );

    const client = createPullRequestReadClient({
      repository: "octo/repo",
      pullNumber: 7,
      getToken: async () => "ghs_token",
    });

    await expect(client.getFileContent("REVIEW.md", "main")).resolves.toBe(japaneseText);
    await expect(client.getFileContent("missing.json", "main")).resolves.toBeNull();
    await expect(client.getFileContent("evil-link", "main")).rejects.toThrow(
      /unsupported content type/,
    );
    await expect(client.getFileContent("huge.txt", "main")).rejects.toThrow(/maximum allowed size/);
    await expect(client.getFileContent("../secret.txt", "main")).rejects.toThrow(
      /invalid repository file path/,
    );
    await expect(client.getFileContent("a/%2e%2e/b", "main")).rejects.toThrow(
      /invalid repository file path/,
    );
  });

  it("postReview(input) と resolveThread が commitId / event / comments[] を正しく送信する", async () => {
    const requests: Array<{ url: string; method: string | undefined; body: string | undefined }> =
      [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        requests.push({
          url,
          method: init?.method,
          body: typeof init?.body === "string" ? init.body : undefined,
        });
        if (url.endsWith("/pulls/7/reviews")) {
          return Response.json({ id: 501 }, { status: 200 });
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

    const posted = await client.postReview({
      commitId: "head999",
      event: "REQUEST_CHANGES",
      body: "総評メッセージ",
      comments: [
        {
          path: "src/sum.ts",
          line: 15,
          startLine: 12,
          side: "RIGHT",
          body: "空配列でクラッシュします\n<!-- review-harness:fp=fp_1 -->",
        },
      ],
    });
    await client.resolveThread("PRRT_1");

    expect(posted).toEqual({ id: 501 });
    expect(requests).toEqual([
      {
        url: "https://api.github.com/repos/octo/repo/pulls/7/reviews",
        method: "POST",
        body: JSON.stringify({
          body: "総評メッセージ",
          event: "REQUEST_CHANGES",
          commit_id: "head999",
          comments: [
            {
              path: "src/sum.ts",
              line: 15,
              side: "RIGHT",
              start_line: 12,
              start_side: "RIGHT",
              body: "空配列でクラッシュします\n<!-- review-harness:fp=fp_1 -->",
            },
          ],
        }),
      },
      {
        url: "https://api.github.com/graphql",
        method: "POST",
        body: JSON.stringify({
          query:
            "mutation($threadId: ID!) { resolveReviewThread(input: { threadId: $threadId }) { thread { id isResolved } } }",
          variables: { threadId: "PRRT_1" },
        }),
      },
    ]);
  });
});
