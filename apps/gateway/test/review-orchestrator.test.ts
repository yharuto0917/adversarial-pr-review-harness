import { env, runInDurableObject } from "cloudflare:test";
import type { MutableModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { VAULT_INSTANCE_NAME } from "@repo/orchestrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { executed, faux, type ProductionOrchestrator } from "./worker.js";

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
