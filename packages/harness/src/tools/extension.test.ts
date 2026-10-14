import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import type { FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";

import type { FindingDraft, HarnessPorts } from "../ports.js";
import { createReviewExtension } from "./extension.js";

const context = BACKGROUND_CONTEXT;

function fakePorts() {
  const calls: string[] = [];
  const reported: FindingDraft[] = [];
  const ports: HarnessPorts = {
    sandbox: {
      exec: async (command) => {
        calls.push(`exec ${command}`);
        return { stdout: "1 failed", stderr: "", exitCode: 1 };
      },
      readFile: async (path) => `content of ${path}`,
      writeFile: async () => {},
      listFiles: async () => [],
    },
    github: {
      getDiff: async () => {
        calls.push("getDiff");
        return "diff --git a/src/sum.ts b/src/sum.ts";
      },
      postReview: async (body) => {
        calls.push(`postReview ${body}`);
      },
      resolveThread: async () => {},
    },
    findings: {
      report: async (finding) => {
        reported.push(finding);
      },
    },
  };
  return { ports, calls, reported };
}

/** 台本どおりに応答する擬似モデルで、レビュー拡張を載せた Pi のループを 1 回走らせる。 */
async function runReview(responses: FauxResponseStep[]) {
  const fakes = fakePorts();
  const faux = fauxProvider();
  faux.setResponses(responses);
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(createReviewExtension(fakes.ports));

  const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
  const model = faux.getModel();
  const root = await harness.root(context, {
    agent: { model: { provider: model.provider, modelId: model.id } },
  });
  const submission = await root.submit({ type: "input", content: "PR #1 をレビュー" }, context);
  const settled = await submission.wait(context);
  await harness.close(context);

  return { ...fakes, settled, pendingResponses: faux.getPendingResponseCount() };
}

const toolCall = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
  fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

describe("createReviewExtension", () => {
  it("Pi のループからツールが呼ばれ、指摘が FindingsPort に届く", async () => {
    const { calls, reported, settled, pendingResponses } = await runReview([
      toolCall("get_diff", {}),
      toolCall("exec", { command: "pnpm test" }),
      toolCall("report_finding", {
        path: "src/sum.ts",
        line: 3,
        severity: "major",
        title: "空配列で例外になる",
        body: "pnpm test が 1 件失敗する。",
      }),
      toolCall("post_review", { body: "1 件の問題を確認" }),
      fauxAssistantMessage(fauxText("レビュー完了")),
    ]);

    expect(settled.status).toBe("done");
    expect(calls).toEqual(["getDiff", "exec pnpm test", "postReview 1 件の問題を確認"]);
    expect(reported).toEqual([
      {
        path: "src/sum.ts",
        line: 3,
        severity: "major",
        title: "空配列で例外になる",
        body: "pnpm test が 1 件失敗する。",
      },
    ]);
    expect(pendingResponses).toBe(0);
  });

  it("行番号を省いた指摘は line: null として記録する", async () => {
    const { reported } = await runReview([
      toolCall("report_finding", {
        path: "README.md",
        severity: "nit",
        title: "手順が古い",
        body: "",
      }),
      fauxAssistantMessage(fauxText("完了")),
    ]);

    expect(reported).toEqual([
      { path: "README.md", line: null, severity: "nit", title: "手順が古い", body: "" },
    ]);
  });

  it("スキーマに合わない指摘は FindingsPort に届かない", async () => {
    const { reported } = await runReview([
      toolCall("report_finding", {
        path: "src/sum.ts",
        severity: "critical",
        title: "不正な深刻度",
        body: "",
      }),
      fauxAssistantMessage(fauxText("完了")),
    ]);

    expect(reported).toEqual([]);
  });
});
