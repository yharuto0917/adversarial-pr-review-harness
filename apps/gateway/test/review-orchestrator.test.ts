import { env, runInDurableObject } from "cloudflare:test";
import type { MutableModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
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
};

describe("ReviewOrchestrator", () => {
  beforeEach(() => {
    executed.length = 0;
    sandboxFiles.clear();
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
