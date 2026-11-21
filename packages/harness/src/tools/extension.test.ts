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

import type {
  ExecResult,
  FindingDraft,
  HarnessPorts,
  SandboxPortExecOptions,
  SandboxService,
} from "../ports.js";
import { bindSandbox } from "../ports.js";
import { createReviewExtension } from "./extension.js";

const context = BACKGROUND_CONTEXT;

function fakePorts(execResult?: ExecResult) {
  const calls: string[] = [];
  const execCalls: Array<{
    readonly command: string;
    readonly options: SandboxPortExecOptions | undefined;
    readonly argCount: number;
  }> = [];
  const reported: FindingDraft[] = [];
  const ports: HarnessPorts = {
    sandbox: {
      exec: async (...args: [string, SandboxPortExecOptions?]) => {
        const [command, options] = args;
        calls.push(`exec ${command}`);
        execCalls.push({ command, options, argCount: args.length });
        return execResult ?? { stdout: "1 failed", stderr: "", exitCode: 1 };
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
  return { ports, calls, execCalls, reported };
}

/** 台本どおりに応答する擬似モデルで、レビュー拡張を載せた Pi のループを 1 回走らせる。 */
async function runReview(responses: FauxResponseStep[], execResult?: ExecResult) {
  const fakes = fakePorts(execResult);
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

  it("exec ツールは timeoutSeconds 指定時のみ timeoutMs を渡し、タイムアウト時は isError: true と (timed out) を返す", async () => {
    const toolResults: Array<{ isError: boolean; text: string }> = [];
    const { execCalls } = await runReview(
      [
        toolCall("exec", { command: "pnpm test" }),
        toolCall("exec", { command: "pnpm run slow-test", timeoutSeconds: 45 }),
        (ctx) => {
          for (const msg of ctx.messages) {
            if (msg.role === "toolResult") {
              const text = msg.content
                .flatMap((part) => (part.type === "text" ? [part.text] : []))
                .join("");
              toolResults.push({ isError: msg.isError, text });
            }
          }
          return fauxAssistantMessage(fauxText("タイムアウト確認"));
        },
      ],
      {
        stdout: "partial",
        stderr: "command timed out after 45000ms",
        exitCode: 124,
        timedOut: true,
      },
    );

    expect(execCalls).toEqual([
      { command: "pnpm test", options: undefined, argCount: 1 },
      { command: "pnpm run slow-test", options: { timeoutMs: 45_000 }, argCount: 2 },
    ]);
    expect(toolResults[1]).toEqual({
      isError: true,
      text: "exit code: 124 (timed out)\n--- stdout ---\npartial\n--- stderr ---\ncommand timed out after 45000ms",
    });
  });
});

describe("bindSandbox", () => {
  it("SandboxPort 経由の実行時オブジェクトに egress が混入しても timeoutMs だけを転送し egress を上書きさせない", async () => {
    const serviceCalls: Array<{
      readonly sandboxId: string;
      readonly command: string;
      readonly options: unknown;
      readonly argCount: number;
    }> = [];
    const service: SandboxService = {
      exec: async (...args) => {
        const [sandboxId, command, options] = args;
        serviceCalls.push({ sandboxId, command, options, argCount: args.length });
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      readFile: async () => "",
      writeFile: async () => {},
      listFiles: async () => [],
      destroy: async () => {},
    };

    const lockedPort = bindSandbox(service, "sb-1");
    await lockedPort.exec("echo plain");
    await lockedPort.exec("echo inject", {
      timeoutMs: 15_000,
      egress: { profile: "install" },
    } as unknown as SandboxPortExecOptions);

    const installPort = bindSandbox(service, "sb-2", { egress: { profile: "install" } });
    await installPort.exec("pnpm install", { timeoutMs: 180_000 });

    expect(serviceCalls).toEqual([
      { sandboxId: "sb-1", command: "echo plain", options: undefined, argCount: 2 },
      { sandboxId: "sb-1", command: "echo inject", options: { timeoutMs: 15_000 }, argCount: 3 },
      {
        sandboxId: "sb-2",
        command: "pnpm install",
        options: { egress: { profile: "install" }, timeoutMs: 180_000 },
        argCount: 3,
      },
    ]);
  });
});
