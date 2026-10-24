import { env, runInDurableObject } from "cloudflare:test";
import type { MutableModels } from "@earendil-works/pi-ai";
import {
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { clearInstallationTokenCache } from "@repo/github";
import { VAULT_INSTANCE_NAME } from "@repo/orchestrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  executed,
  faux,
  type ProductionOrchestrator,
  remoteRepoFiles,
  sandboxFiles,
} from "./worker.js";

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
    remoteRepoFiles.clear();
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
    expect(executed).toEqual([
      expect.stringContaining("https://github.com/octo/repo.git -- abc123"),
      "pnpm test",
    ]);
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
    expect(executed).toEqual([
      expect.stringContaining("https://github.com/octo/repo.git -- abc123"),
      "cat repro.txt",
    ]);
  });

  it("start() で PR の head をチェックアウトし、read_file でファイルが読め、token を環境変数やファイルに残さない", async () => {
    remoteRepoFiles.set("octo/repo@abc123", {
      "src/sum.ts": "export const sum = (ns: number[]) => ns.reduce((a, b) => a + b);\n",
      "package.json": '{"name":"octo-repo"}\n',
    });
    const toolResults: Array<{ toolName: string; isError: boolean; text: string }> = [];
    faux.setResponses([
      toolCall("read_file", { path: "src/sum.ts" }),
      (context) => {
        for (const msg of context.messages) {
          if (msg.role === "toolResult") {
            const text = msg.content
              .flatMap((part) => (part.type === "text" ? [part.text] : []))
              .join("");
            toolResults.push({ toolName: msg.toolName, isError: msg.isError, text });
          }
        }
        return fauxAssistantMessage(fauxText("ファイル読み取り成功"));
      },
    ]);

    const orchestrator = env.ORCHESTRATOR.getByName("octo/repo#6");
    await orchestrator.start(request);
    const result = await orchestrator.result(request.deliveryId);

    expect(result).toMatchObject({ status: "done", text: "ファイル読み取り成功" });
    expect(toolResults).toEqual([
      {
        toolName: "read_file",
        isError: false,
        text: "export const sum = (ns: number[]) => ns.reduce((a, b) => a + b);\n",
      },
    ]);

    expect(executed).toHaveLength(1);
    const checkoutCmd = executed[0] ?? "";
    const expectedBasicAuth = btoa("x-access-token:ghs_inst_42");
    expect(checkoutCmd).toContain(
      `-c "http.extraHeader=Authorization: Basic ${expectedBasicAuth}"`,
    );
    expect(checkoutCmd).not.toContain("ghs_inst_42");
    expect(checkoutCmd).not.toContain("x-access-token:");
    expect(checkoutCmd).not.toMatch(/\bexport\b/);

    for (const files of sandboxFiles.values()) {
      for (const [path, content] of files.entries()) {
        expect(path).not.toContain("ghs_inst_42");
        expect(content).not.toContain("ghs_inst_42");
        expect(content).not.toContain(expectedBasicAuth);
      }
    }
  });

  it("head が同じなら再利用して再取得せず、head が更新されたら取り直す", async () => {
    remoteRepoFiles.set("octo/repo@sha-v1", { "src/sum.ts": "v1\n" });
    remoteRepoFiles.set("octo/repo@sha-v2", { "src/sum.ts": "v2\n" });
    const readOutputs: string[] = [];

    const captureLastRead: FauxResponseStep = (context) => {
      const lastToolResult = [...context.messages].reverse().find((m) => m.role === "toolResult");
      const text =
        lastToolResult?.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("") ?? "";
      readOutputs.push(text);
      return fauxAssistantMessage(fauxText(`read:${text.trim()}`));
    };

    const orchestrator = env.ORCHESTRATOR.getByName("octo/repo#7");

    // 1 回目: sha-v1 をチェックアウトし、作業ファイル repro.txt も作る
    faux.setResponses([
      toolCall("write_file", { path: "repro.txt", content: "local-repro" }),
      toolCall("read_file", { path: "src/sum.ts" }),
      captureLastRead,
    ]);
    await orchestrator.start({ ...request, deliveryId: "del-v1-a", headSha: "sha-v1" });
    await orchestrator.result("del-v1-a");
    expect(executed).toHaveLength(1);
    expect(readOutputs).toEqual(["v1\n"]);

    // 2 回目: 同じ sha-v1 の別 delivery → 再取得せず、前回の repro.txt も残っている
    faux.setResponses([toolCall("read_file", { path: "repro.txt" }), captureLastRead]);
    await orchestrator.start({ ...request, deliveryId: "del-v1-b", headSha: "sha-v1" });
    await orchestrator.result("del-v1-b");
    expect(executed).toHaveLength(1);
    expect(readOutputs).toEqual(["v1\n", "local-repro"]);

    // 3 回目: sha-v2 に更新 → 取り直され、src/sum.ts が v2 になり repro.txt は消える
    faux.setResponses([toolCall("read_file", { path: "src/sum.ts" }), captureLastRead]);
    await orchestrator.start({ ...request, deliveryId: "del-v2", headSha: "sha-v2" });
    await orchestrator.result("del-v2");
    expect(executed).toHaveLength(2);
    expect(executed[1]).toContain("https://github.com/octo/repo.git -- sha-v2");
    expect(readOutputs).toEqual(["v1\n", "local-repro", "v2\n"]);
    const [sandboxId] = [...sandboxFiles.keys()];
    expect(sandboxFiles.get(sandboxId ?? "")?.has("repro.txt")).toBe(false);
  });

  it("チェックアウト失敗時はトークンをマスクして例外を投げ、次回は再取得を試みる", async () => {
    const stub = env.ORCHESTRATOR.getByName("octo/repo#8");
    const expectedBasicAuth = btoa("x-access-token:ghs_inst_42");

    await runInDurableObject(stub, async (instance) => {
      const orchestrator = instance as ProductionOrchestrator;
      await expect(
        orchestrator.start({ ...request, deliveryId: "del-fail", headSha: "fail-sha" }),
      ).rejects.toSatisfy((error: unknown) => {
        const msg = error instanceof Error ? error.message : String(error);
        expect(msg).toContain("failed to checkout octo/repo@fail-sha (exit 128)");
        expect(msg).toContain("[REDACTED]");
        expect(msg).toContain("fetch output");
        expect(msg).not.toContain("ghs_inst_42");
        expect(msg).not.toContain(expectedBasicAuth);
        return true;
      });

      await expect(
        orchestrator.start({
          ...request,
          deliveryId: "del-bad-ref",
          headSha: "--upload-pack=evil",
        }),
      ).rejects.toThrow("invalid headSha");
    });

    // 失敗後は checked_out_sha が記録されないため、続く正常なリクエストで取得が走る
    remoteRepoFiles.set("octo/repo@abc123", { "src/sum.ts": "recovered\n" });
    faux.setResponses([fauxAssistantMessage(fauxText("復旧"))]);
    const receipt = await stub.start({ ...request, deliveryId: "del-recover" });
    const result = await stub.result("del-recover");
    expect(receipt.accepted).toBe(true);
    expect(result).toMatchObject({ status: "done", text: "復旧" });
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
