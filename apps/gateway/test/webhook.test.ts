import { env, SELF } from "cloudflare:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { clearInstallationTokenCache } from "@repo/github";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { destroyedSandboxes, executed, faux, sandboxFiles, sandboxTestConfig } from "./worker.js";

const WEBHOOK_SECRET = "test-webhook-secret";

async function signPayload(payload: string, secret: string = WEBHOOK_SECRET): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)));
  const hex = [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `sha256=${hex}`;
}

function makePullRequestPayload(
  action: string,
  repository = "octo/repo",
  pullNumber = 10,
  headSha = "deadbeef",
  installationId = 777,
  options?: { readonly baseSha?: string; readonly isFork?: boolean },
) {
  const baseSha = options?.baseSha ?? "base000";
  const isFork = options?.isFork ?? false;
  return JSON.stringify({
    action,
    number: pullNumber,
    pull_request: {
      number: pullNumber,
      base: {
        sha: baseSha,
        ref: "main",
        repo: { id: 100, full_name: repository, default_branch: "main" },
      },
      head: {
        sha: headSha,
        ref: "feat/x",
        repo: isFork
          ? { id: 200, full_name: "external/repo", default_branch: "main" }
          : { id: 100, full_name: repository, default_branch: "main" },
      },
    },
    repository: { id: 100, full_name: repository, default_branch: "main" },
    installation: { id: installationId },
  });
}

function makeCheckSuitePayload(params: {
  readonly action?: string;
  readonly repository?: string;
  readonly repoId?: number;
  readonly headSha?: string;
  readonly appId?: number;
  readonly pullRequests?: ReadonlyArray<{ readonly number: number; readonly baseRepoId?: number }>;
}) {
  return JSON.stringify({
    action: params.action ?? "completed",
    check_suite: {
      id: 9001,
      head_sha: params.headSha ?? "sha-ci-1",
      conclusion: "success",
      app: { id: params.appId ?? 10 },
      pull_requests: (params.pullRequests ?? []).map((pr) => ({
        number: pr.number,
        base: { repo: { id: pr.baseRepoId ?? params.repoId ?? 100 } },
      })),
    },
    repository: { id: params.repoId ?? 100, full_name: params.repository ?? "octo/repo" },
  });
}

function installDefaultGitHubMock(options?: {
  readonly headShaByPull?: Readonly<Record<number, string>>;
  readonly isForkByPull?: Readonly<Record<number, boolean>>;
  readonly checkStatusBySha?: () => Readonly<Record<string, "in_progress" | "passed">>;
}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const accept = new Headers(init?.headers).get("Accept") ?? "";

      if (url.endsWith("/app/installations/777/access_tokens")) {
        const expiresAt = new Date(Date.now() + 3600_000).toISOString();
        return Response.json({ token: "ghs_inst_777", expires_at: expiresAt }, { status: 201 });
      }

      const prMatch = /\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/.exec(url);
      if (prMatch) {
        const repo = prMatch[1] ?? "octo/repo";
        const pullNum = Number(prMatch[2]);
        if (accept.includes("v3.diff")) {
          return new Response("diff --git a/src/a.ts b/src/a.ts\n+export const x = 1;\n", {
            status: 200,
          });
        }
        const headSha = options?.headShaByPull?.[pullNum] ?? "sha123";
        const isFork = options?.isForkByPull?.[pullNum] ?? false;
        return Response.json({
          number: pullNum,
          state: "open",
          draft: false,
          title: `PR #${pullNum}`,
          body: null,
          user: { login: "alice" },
          base: {
            sha: "base000",
            ref: "main",
            repo: { id: 100, full_name: repo, default_branch: "main" },
          },
          head: {
            sha: headSha,
            ref: "feat/x",
            repo: isFork
              ? { id: 200, full_name: "external/repo", default_branch: "main" }
              : { id: 100, full_name: repo, default_branch: "main" },
          },
        });
      }

      if (url.includes("/compare/")) {
        return new Response("diff --git a/src/a.ts b/src/a.ts\n+export const x = 1;\n", {
          status: 200,
        });
      }

      if (url.includes("/contents/")) {
        return new Response("Not Found", { status: 404 });
      }

      const checkRunsMatch = /\/commits\/([^/?]+)\/check-runs/.exec(url);
      if (checkRunsMatch) {
        const sha = decodeURIComponent(checkRunsMatch[1] ?? "");
        const state = options?.checkStatusBySha?.()[sha] ?? "passed";
        return Response.json({
          check_runs: [
            {
              id: 101,
              name: "CI / test",
              head_sha: sha,
              status: state === "in_progress" ? "in_progress" : "completed",
              conclusion: state === "in_progress" ? null : "success",
              app: { id: 10, slug: "github-actions" },
              output: { title: "tests", summary: "ok", annotations_count: 0 },
            },
          ],
        });
      }

      const suitesMatch = /\/commits\/([^/?]+)\/check-suites/.exec(url);
      if (suitesMatch) {
        const sha = decodeURIComponent(suitesMatch[1] ?? "");
        const state = options?.checkStatusBySha?.()[sha] ?? "passed";
        return Response.json({
          check_suites: [
            {
              id: 500,
              head_sha: sha,
              status: state === "in_progress" ? "in_progress" : "completed",
              conclusion: state === "in_progress" ? null : "success",
              app: { id: 10, slug: "github-actions" },
            },
          ],
        });
      }

      const statusMatch = /\/commits\/([^/?]+)\/status/.exec(url);
      if (statusMatch) {
        const sha = decodeURIComponent(statusMatch[1] ?? "");
        return Response.json({ sha, state: "success", statuses: [] });
      }

      return new Response(`unexpected url: ${url}`, { status: 404 });
    }),
  );
}

describe("POST /webhook/github", () => {
  beforeEach(() => {
    executed.length = 0;
    destroyedSandboxes.length = 0;
    sandboxFiles.clear();
    sandboxTestConfig.hangCommand = null;
    sandboxTestConfig.ciPollIntervalMs = null;
    sandboxTestConfig.ciWaitTimeoutMs = null;
    sandboxTestConfig.ciDiscoveryGraceMs = 0;
    sandboxTestConfig.managedRepoConfig = null;
    clearInstallationTokenCache();
    installDefaultGitHubMock({
      headShaByPull: {
        201: "sha123",
        202: "sha123",
        203: "sha123",
        301: "sha-dup",
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ["署名ヘッダなし", undefined],
    ["誤った署名", "sha256=0000000000000000000000000000000000000000000000000000000000000000"],
    ["不正な形式の署名", "sha1=deadbeef"],
  ])("%s の場合は 401 を返し、レビューを開始しない", async (_label, signature) => {
    const callsBefore = faux.state.callCount;
    const body = makePullRequestPayload("opened", "octo/repo", 101);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-github-event": "pull_request",
      "x-github-delivery": "delivery-unauth-1",
    };
    if (signature !== undefined) {
      headers["x-hub-signature-256"] = signature;
    }

    const response = await SELF.fetch("https://example.com/webhook/github", {
      method: "POST",
      headers,
      body,
    });

    expect(response.status).toBe(401);
    expect(faux.state.callCount).toBe(callsBefore);
  });

  it("サポート外イベントや pull_request の対象外 action (edited / labeled) は 202 で無視し、レビューを開始しない", async () => {
    const callsBefore = faux.state.callCount;

    const pingBody = JSON.stringify({ zen: "Keep it logically awesome." });
    const pingRes = await SELF.fetch("https://example.com/webhook/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "ping",
        "x-github-delivery": "delivery-ping-1",
        "x-hub-signature-256": await signPayload(pingBody),
      },
      body: pingBody,
    });
    expect(pingRes.status).toBe(202);
    await expect(pingRes.json()).resolves.toMatchObject({ ok: true, ignored: true });

    for (const action of ["edited", "labeled"]) {
      const body = makePullRequestPayload(action, "octo/repo", 102);
      const res = await SELF.fetch("https://example.com/webhook/github", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "pull_request",
          "x-github-delivery": `delivery-${action}`,
          "x-hub-signature-256": await signPayload(body),
        },
        body,
      });
      expect(res.status).toBe(202);
      await expect(res.json()).resolves.toMatchObject({ ok: true, ignored: true });
    }

    expect(faux.state.callCount).toBe(callsBefore);
  });

  it.each(["opened", "synchronize", "reopened"] as const)(
    "pull_request (%s) で baseSha / isFork を伝播し owner/name#番号 の DO に start() を呼び 202 を返す",
    async (action) => {
      faux.setResponses([fauxAssistantMessage(fauxText(`reviewed-${action}`))]);
      const pullNumber = action === "opened" ? 201 : action === "synchronize" ? 202 : 203;
      const deliveryId = `delivery-${action}-${pullNumber}`;
      const body = makePullRequestPayload(action, "octo/repo", pullNumber, "sha123");

      const response = await SELF.fetch("https://example.com/webhook/github", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "pull_request",
          "x-github-delivery": deliveryId,
          "x-hub-signature-256": await signPayload(body),
        },
        body,
      });

      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toEqual({
        ok: true,
        deliveryId,
        accepted: true,
      });

      const orchestrator = env.ORCHESTRATOR.getByName(`octo/repo#${pullNumber}`);
      const result = await orchestrator.result(deliveryId);
      expect(result).toMatchObject({ status: "done", text: `reviewed-${action}` });
      const state = await orchestrator.step1Status(deliveryId);
      expect(state).toMatchObject({
        baseSha: "base000",
        isFork: false,
        executionMode: "full",
      });
    },
  );

  it("pull_request (closed) で残存 Sandbox を即時破棄し、未初期化 PR では副作用なく終了する", async () => {
    installDefaultGitHubMock({ headShaByPull: { 401: "sha-close-1" } });
    sandboxTestConfig.hangCommand = "sleep 999";
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("exec", { command: "sleep 999" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage(fauxText("到達しない")),
    ]);

    const openBody = makePullRequestPayload("opened", "octo/repo", 401, "sha-close-1");
    await SELF.fetch("https://example.com/webhook/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-github-delivery": "delivery-open-401",
        "x-hub-signature-256": await signPayload(openBody),
      },
      body: openBody,
    });

    await vi.waitFor(() => {
      expect(executed).toContain("sleep 999");
    });

    const closeBody = makePullRequestPayload("closed", "octo/repo", 401, "sha-close-1");
    const closeRes = await SELF.fetch("https://example.com/webhook/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-github-delivery": "delivery-close-401",
        "x-hub-signature-256": await signPayload(closeBody),
      },
      body: closeBody,
    });

    expect(closeRes.status).toBe(202);
    await expect(closeRes.json()).resolves.toMatchObject({
      ok: true,
      action: "closed",
      destroyedSandbox: true,
    });
    expect(destroyedSandboxes).toHaveLength(1);

    // 未初期化 PR の closed は RUNNER.destroy を呼ばず正常応答する
    const unusedCloseBody = makePullRequestPayload("closed", "octo/repo", 402, "sha-unused");
    const unusedRes = await SELF.fetch("https://example.com/webhook/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-github-delivery": "delivery-close-402",
        "x-hub-signature-256": await signPayload(unusedCloseBody),
      },
      body: unusedCloseBody,
    });
    expect(unusedRes.status).toBe(202);
    await expect(unusedRes.json()).resolves.toMatchObject({
      ok: true,
      action: "closed",
      destroyedSandbox: false,
    });
    expect(destroyedSandboxes).toHaveLength(1);
  });

  it("check_suite (completed) で awaiting_ci 中の該当 PR DO のみ起床させ、自 App・非 completed・クロスリポ PR を除外する", async () => {
    let ciState: "in_progress" | "passed" = "in_progress";
    installDefaultGitHubMock({
      headShaByPull: { 501: "sha-await-501" },
      checkStatusBySha: () => ({ "sha-await-501": ciState }),
    });
    sandboxTestConfig.ciPollIntervalMs = 60_000;
    sandboxTestConfig.ciWaitTimeoutMs = 300_000;
    faux.setResponses([fauxAssistantMessage(fauxText("CI 完了後にレビュー実行"))]);

    // 1. PR を開く（CI 進行中なので awaiting_ci で即 202 返却）
    const openBody = makePullRequestPayload("opened", "octo/repo", 501, "sha-await-501");
    const openRes = await SELF.fetch("https://example.com/webhook/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-github-delivery": "delivery-await-501",
        "x-hub-signature-256": await signPayload(openBody),
      },
      body: openBody,
    });
    expect(openRes.status).toBe(202);
    const orchestrator = env.ORCHESTRATOR.getByName("octo/repo#501");
    await expect(orchestrator.step1Status("delivery-await-501")).resolves.toMatchObject({
      stage: "awaiting_ci",
    });

    // 2. 自 App (GITHUB_APP_ID = "12345") の check_suite は無視される
    const selfSuiteBody = makeCheckSuitePayload({
      headSha: "sha-await-501",
      appId: 12345,
      pullRequests: [{ number: 501 }],
    });
    const selfSuiteRes = await SELF.fetch("https://example.com/webhook/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "check_suite",
        "x-github-delivery": "delivery-cs-self",
        "x-hub-signature-256": await signPayload(selfSuiteBody),
      },
      body: selfSuiteBody,
    });
    expect(selfSuiteRes.status).toBe(202);
    await expect(selfSuiteRes.json()).resolves.toMatchObject({ ok: true, ignored: true });

    // 3. CI が完了した状態で check_suite.completed を送る（クロスリポ PR #999 は除外、未待機 PR #502 は woken: false）
    ciState = "passed";
    const suiteBody = makeCheckSuitePayload({
      headSha: "sha-await-501",
      appId: 10,
      pullRequests: [
        { number: 501, baseRepoId: 100 },
        { number: 502, baseRepoId: 100 },
        { number: 999, baseRepoId: 999 },
      ],
    });
    const suiteRes = await SELF.fetch("https://example.com/webhook/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "check_suite",
        "x-github-delivery": "delivery-cs-wake",
        "x-hub-signature-256": await signPayload(suiteBody),
      },
      body: suiteBody,
    });
    expect(suiteRes.status).toBe(202);
    await expect(suiteRes.json()).resolves.toEqual({
      ok: true,
      deliveryId: "delivery-cs-wake",
      notifiedPullNumbers: [501, 502],
      wokenPullNumbers: [501],
    });

    const outcome = await orchestrator.result("delivery-await-501");
    expect(outcome).toMatchObject({ status: "done", text: "CI 完了後にレビュー実行" });
  });

  it("同じ delivery id の再送では二重に実行されない", async () => {
    faux.setResponses([fauxAssistantMessage(fauxText("once"))]);
    const callsBefore = faux.state.callCount;
    const deliveryId = "delivery-duplicate-301";
    const body = makePullRequestPayload("opened", "octo/repo", 301, "sha-dup");
    const signature = await signPayload(body);
    const headers = {
      "content-type": "application/json",
      "x-github-event": "pull_request",
      "x-github-delivery": deliveryId,
      "x-hub-signature-256": signature,
    };

    const first = await SELF.fetch("https://example.com/webhook/github", {
      method: "POST",
      headers,
      body,
    });
    const orchestrator = env.ORCHESTRATOR.getByName("octo/repo#301");
    await orchestrator.result(deliveryId);

    const second = await SELF.fetch("https://example.com/webhook/github", {
      method: "POST",
      headers,
      body,
    });

    expect(first.status).toBe(202);
    await expect(first.json()).resolves.toEqual({ ok: true, deliveryId, accepted: true });
    expect(second.status).toBe(202);
    await expect(second.json()).resolves.toEqual({ ok: true, deliveryId, accepted: false });
    expect(faux.state.callCount - callsBefore).toBe(1);
  });

  it("不正な installation.id や不正な JSON ペイロードは 400 を返す", async () => {
    const badInstallBody = JSON.stringify({
      action: "opened",
      number: 302,
      pull_request: {
        number: 302,
        base: { sha: "base000", repo: { id: 100, full_name: "octo/repo", default_branch: "main" } },
        head: { sha: "sha302", repo: { id: 100, full_name: "octo/repo", default_branch: "main" } },
      },
      repository: { id: 100, full_name: "octo/repo", default_branch: "main" },
      installation: { id: -1 },
    });
    const badInstallRes = await SELF.fetch("https://example.com/webhook/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-github-delivery": "delivery-bad-install",
        "x-hub-signature-256": await signPayload(badInstallBody),
      },
      body: badInstallBody,
    });
    expect(badInstallRes.status).toBe(400);

    const invalidJson = "{broken";
    const badJsonRes = await SELF.fetch("https://example.com/webhook/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-github-delivery": "delivery-bad-json",
        "x-hub-signature-256": await signPayload(invalidJson),
      },
      body: invalidJson,
    });
    expect(badJsonRes.status).toBe(400);
  });
});
