import { env, runInDurableObject } from "cloudflare:test";
import type { MutableModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { clearInstallationTokenCache } from "@repo/github";
import { VAULT_INSTANCE_NAME } from "@repo/orchestrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { executed, faux, type ProductionOrchestrator, sandboxFiles } from "./worker.js";

const toolCall = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
  fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

const request = {
  deliveryId: "delivery-1",
  repository: "octo/repo",
  pullNumber: 1,
  headSha: "abc123",
  installationId: 42,
};

describe("ReviewOrchestrator", () => {
  beforeEach(() => {
    executed.length = 0;
    sandboxFiles.clear();
    clearInstallationTokenCache();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/app/installations/42/access_tokens")) {
          const expiresAt = new Date(Date.now() + 3600_000).toISOString();
          return Response.json({ token: "ghs_inst_42", expires_at: expiresAt }, { status: 201 });
        }
        if (url.endsWith("/repos/octo/repo/pulls/1")) {
          return new Response("diff --git a/src/sum.ts b/src/sum.ts", { status: 200 });
        }
        return new Response("unexpected url", { status: 404 });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("レビューを実行し、報告された指摘を実行単位で保持する", async () => {
    faux.setResponses([
      toolCall("get_diff", {}),
      toolCall("exec", { command: "pnpm test" }),
      toolCall("report_finding", {
        path: "src/sum.ts",
        line: 3,
        severity: "major",
        title: "空配列で例外になる",
        body: "pnpm test が 1 件失敗する。",
      }),
      fauxAssistantMessage(fauxText("レビュー完了")),
    ]);
    const orchestrator = env.ORCHESTRATOR.getByName("octo/repo#1");

    const receipt = await orchestrator.start(request);
    const result = await orchestrator.result(request.deliveryId);

    expect(receipt).toMatchObject({ operationId: "delivery-1", accepted: true });
    expect(result).toMatchObject({ status: "done", text: "レビュー完了" });
    expect(executed).toEqual(["pnpm test"]);
    await expect(orchestrator.findings("delivery-1")).resolves.toEqual([
      {
        operationId: "delivery-1",
        path: "src/sum.ts",
        line: 3,
        severity: "major",
        title: "空配列で例外になる",
        body: "pnpm test が 1 件失敗する。",
      },
    ]);
    await expect(orchestrator.findings("other-delivery")).resolves.toEqual([]);
  });

  it("同じ delivery id の再送ではレビューを二重に実行しない", async () => {
    faux.setResponses([fauxAssistantMessage(fauxText("問題なし"))]);
    const orchestrator = env.ORCHESTRATOR.getByName("octo/repo#2");
    const callsBefore = faux.state.callCount;

    const first = await orchestrator.start(request);
    await orchestrator.result(request.deliveryId);
    const second = await orchestrator.start(request);

    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(false);
    expect(faux.state.callCount - callsBefore).toBe(1);
  });

  it("ports().sandbox を差し替えず RUNNER RPC 経由で 4 つのツールすべてがサンドボックスに届き結果が返る", async () => {
    const toolResults: Array<{ toolName: string; isError: boolean; text: string }> = [];
    faux.setResponses([
      toolCall("write_file", { path: "repro.txt", content: "from-orchestrator" }),
      toolCall("read_file", { path: "repro.txt" }),
      toolCall("list_files", { path: "." }),
      toolCall("exec", { command: "cat repro.txt" }),
      (context) => {
        for (const msg of context.messages) {
          if (msg.role === "toolResult") {
            const text = msg.content
              .flatMap((part) => (part.type === "text" ? [part.text] : []))
              .join("");
            toolResults.push({ toolName: msg.toolName, isError: msg.isError, text });
          }
        }
        return fauxAssistantMessage(fauxText("4 操作とも到達"));
      },
    ]);
    const orchestrator = env.ORCHESTRATOR.getByName("octo/repo#4");

    await orchestrator.start(request);
    const result = await orchestrator.result(request.deliveryId);

    expect(result).toMatchObject({ status: "done", text: "4 操作とも到達" });
    expect(toolResults).toEqual([
      { toolName: "write_file", isError: false, text: "wrote repro.txt" },
      { toolName: "read_file", isError: false, text: "from-orchestrator" },
      { toolName: "list_files", isError: false, text: "repro.txt" },
      { toolName: "exec", isError: false, text: "exit code: 0\n--- stdout ---\nfrom-orchestrator" },
    ]);
    const [sandboxId] = [...sandboxFiles.keys()];
    expect(sandboxId).toMatch(/^[0-9a-f]{64}$/);
    expect(sandboxFiles.get(sandboxId ?? "")?.get("repro.txt")).toBe("from-orchestrator");
    expect(executed).toEqual(["cat repro.txt"]);
  });

  it("ports().github を差し替えず get_diff / post_review / resolve_thread の 3 操作が installation token 経由で GitHub API に届く", async () => {
    const githubCalls: Array<{
      url: string;
      method: string | undefined;
      auth: string | undefined;
      accept: string | undefined;
      body: string | undefined;
    }> = [];
    const toolResults: Array<{ toolName: string; isError: boolean; text: string }> = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const headers = new Headers(init?.headers);
        githubCalls.push({
          url,
          method: init?.method,
          auth: headers.get("Authorization") ?? undefined,
          accept: headers.get("Accept") ?? undefined,
          body: typeof init?.body === "string" ? init.body : undefined,
        });
        if (url.endsWith("/app/installations/99/access_tokens")) {
          const expiresAt = new Date(Date.now() + 3600_000).toISOString();
          return Response.json(
            { token: "ghs_secret_token_99", expires_at: expiresAt },
            { status: 201 },
          );
        }
        if (url.endsWith("/repos/octo/repo/pulls/5")) {
          return new Response("diff --git a/index.ts b/index.ts\n+const x = 1;", { status: 200 });
        }
        if (url.endsWith("/repos/octo/repo/pulls/5/reviews")) {
          return Response.json({ id: 501 }, { status: 200 });
        }
        if (url.endsWith("/graphql")) {
          return Response.json({
            data: { resolveReviewThread: { thread: { id: "PRRT_kwDO999", isResolved: true } } },
          });
        }
        return new Response("not found", { status: 404 });
      }),
    );

    faux.setResponses([
      toolCall("get_diff", {}),
      toolCall("resolve_thread", { threadId: "PRRT_kwDO999" }),
      toolCall("post_review", { body: "すべて問題ありません。" }),
      (context) => {
        for (const msg of context.messages) {
          if (msg.role === "toolResult") {
            const text = msg.content
              .flatMap((part) => (part.type === "text" ? [part.text] : []))
              .join("");
            toolResults.push({ toolName: msg.toolName, isError: msg.isError, text });
          }
        }
        return fauxAssistantMessage(fauxText("GitHub 3 操作完了"));
      },
    ]);

    const orchestrator = env.ORCHESTRATOR.getByName("octo/repo#5");
    await orchestrator.start({
      deliveryId: "delivery-github-5",
      repository: "octo/repo",
      pullNumber: 5,
      headSha: "sha555",
      installationId: 99,
    });
    const result = await orchestrator.result("delivery-github-5");

    expect(result).toMatchObject({ status: "done", text: "GitHub 3 操作完了" });
    expect(toolResults).toEqual([
      {
        toolName: "get_diff",
        isError: false,
        text: "diff --git a/index.ts b/index.ts\n+const x = 1;",
      },
      { toolName: "resolve_thread", isError: false, text: "resolved PRRT_kwDO999" },
      { toolName: "post_review", isError: false, text: "posted" },
    ]);
    // ツール結果にトークンが含まれないことを確認
    for (const r of toolResults) {
      expect(r.text).not.toContain("ghs_secret_token_99");
    }

    // 1 回目の installation token 発行 + 3 つの GitHub API 呼び出し（キャッシュ再利用で計 4 回）
    expect(githubCalls).toHaveLength(4);
    expect(githubCalls[0]?.url).toBe("https://api.github.com/app/installations/99/access_tokens");
    expect(githubCalls[0]?.method).toBe("POST");
    expect(githubCalls[0]?.auth).toMatch(/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

    expect(githubCalls.slice(1)).toEqual([
      {
        url: "https://api.github.com/repos/octo/repo/pulls/5",
        method: "GET",
        auth: "Bearer ghs_secret_token_99",
        accept: "application/vnd.github.v3.diff",
        body: undefined,
      },
      {
        url: "https://api.github.com/graphql",
        method: "POST",
        auth: "Bearer ghs_secret_token_99",
        accept: "application/vnd.github+json",
        body: JSON.stringify({
          query:
            "mutation($threadId: ID!) { resolveReviewThread(input: { threadId: $threadId }) { thread { id isResolved } } }",
          variables: { threadId: "PRRT_kwDO999" },
        }),
      },
      {
        url: "https://api.github.com/repos/octo/repo/pulls/5/reviews",
        method: "POST",
        auth: "Bearer ghs_secret_token_99",
        accept: "application/vnd.github+json",
        body: JSON.stringify({ body: "すべて問題ありません。", event: "COMMENT" }),
      },
    ]);
  });
});

describe("ReviewOrchestrator（差し替えなし）", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("OpenAI の認証を vault 経由で解決し、期限切れなら更新後のトークンを使う", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json({
        access_token: "refreshed-access",
        refresh_token: "refreshed-refresh",
        scope: "openid chatgpt.tokens.use.direct",
        expires_in: 3600,
      }),
    );
    await env.VAULT.getByName(VAULT_INSTANCE_NAME).importCredential("openai", {
      type: "oauth",
      access: "old-access",
      refresh: "old-refresh",
      expires: Date.now() - 1_000,
      clientId: "client-123",
    });
    const namespace = (
      env as unknown as { PRODUCTION_ORCHESTRATOR: DurableObjectNamespace<ProductionOrchestrator> }
    ).PRODUCTION_ORCHESTRATOR;

    const auth = await runInDurableObject(namespace.getByName("octo/repo#3"), (instance) =>
      (instance as unknown as { createModels(): MutableModels }).createModels().getAuth("openai"),
    );

    expect(auth?.auth.apiKey).toBe("refreshed-access");
  });
});
