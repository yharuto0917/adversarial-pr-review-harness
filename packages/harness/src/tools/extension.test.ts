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
import type { ExecutionMode } from "@repo/review-core";
import { describe, expect, it } from "vitest";

import type {
  ExecResult,
  FindingDraft,
  HarnessPorts,
  SandboxPortExecOptions,
  SandboxService,
} from "../ports.js";
import { bindSandbox, guardSandboxPort, StaticOnlyPolicyError } from "../ports.js";
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
      getPullRequestMeta: async () => ({
        number: 1,
        state: "open",
        draft: false,
        title: "Test PR",
        body: null,
        authorLogin: "alice",
        baseSha: "base1",
        headSha: "head1",
        baseRef: "main",
        headRef: "feat/x",
        defaultBranch: "main",
        baseRepoId: 1,
        headRepoId: 1,
        baseRepoFullName: "octo/repo",
        headRepoFullName: "octo/repo",
        isFork: false,
      }),
      getDiff: async () => {
        calls.push("getDiff");
        return "diff --git a/src/sum.ts b/src/sum.ts";
      },
      listPullRequestFiles: async () => ({ files: [], truncated: false }),
      getCommitChecks: async (headSha) => ({
        headSha,
        checks: [],
        checkSuites: [],
        truncated: false,
      }),
      listReviewThreads: async () => ({ threads: [], truncated: false }),
      getFileContent: async () => null,
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
async function runReview(
  responses: FauxResponseStep[],
  options?: { readonly execResult?: ExecResult; readonly executionMode?: ExecutionMode },
) {
  const fakes = fakePorts(options?.execResult);
  const faux = fauxProvider();
  faux.setResponses(responses);
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  const extension = createReviewExtension(fakes.ports, {
    ...(options?.executionMode !== undefined ? { executionMode: options.executionMode } : {}),
  });
  registry.install(extension);

  const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
  const model = faux.getModel();
  const root = await harness.root(context, {
    agent: { model: { provider: model.provider, modelId: model.id } },
  });
  const submission = await root.submit({ type: "input", content: "PR #1 をレビュー" }, context);
  const settled = await submission.wait(context);
  await harness.close(context);

  const registeredToolNames = (extension.tools ?? []).map((t) => t.name);
  return {
    ...fakes,
    settled,
    registeredToolNames,
    pendingResponses: faux.getPendingResponseCount(),
  };
}

const toolCall = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
  fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

describe("createReviewExtension", () => {
  it("Pi のループから Read 専用 GitHub ツール・Sandbox・Findings が呼ばれ、post_review / resolve_thread は登録されない", async () => {
    const { calls, reported, settled, registeredToolNames, pendingResponses } = await runReview([
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

    expect(settled.status).toBe("done");
    expect(calls).toEqual(["getDiff", "exec pnpm test"]);
    expect(registeredToolNames).toContain("get_diff");
    expect(registeredToolNames).not.toContain("post_review");
    expect(registeredToolNames).not.toContain("resolve_thread");
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

  it("executionMode=static_only では exec と write_file がツール登録から除外される", async () => {
    const { registeredToolNames } = await runReview(
      [fauxAssistantMessage(fauxText("静的レビュー完了"))],
      { executionMode: "static_only" },
    );

    expect(registeredToolNames).toContain("get_diff");
    expect(registeredToolNames).toContain("read_file");
    expect(registeredToolNames).toContain("list_files");
    expect(registeredToolNames).toContain("report_finding");
    expect(registeredToolNames).not.toContain("exec");
    expect(registeredToolNames).not.toContain("write_file");
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
        execResult: {
          stdout: "partial",
          stderr: "command timed out after 45000ms",
          exitCode: 124,
          timedOut: true,
        },
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

describe("bindSandbox / guardSandboxPort", () => {
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

  it("guardSandboxPort は実行モードの動的切替に応じて exec / writeFile を StaticOnlyPolicyError で遮断する", async () => {
    const rawCalls: string[] = [];
    let mode: ExecutionMode = "full";
    const guarded = guardSandboxPort(
      {
        exec: async (cmd) => {
          rawCalls.push(`exec:${cmd}`);
          return { stdout: "", stderr: "", exitCode: 0 };
        },
        readFile: async (path) => {
          rawCalls.push(`read:${path}`);
          return "ok";
        },
        writeFile: async (path) => {
          rawCalls.push(`write:${path}`);
        },
        listFiles: async (path) => {
          rawCalls.push(`list:${path}`);
          return [];
        },
      },
      () => mode,
      () => "fork_pr",
    );

    await guarded.exec("pnpm test");
    await guarded.writeFile("a.txt", "1");

    mode = "static_only";
    await expect(guarded.exec("pnpm test")).rejects.toThrow(StaticOnlyPolicyError);
    await expect(guarded.writeFile("a.txt", "2")).rejects.toThrow(StaticOnlyPolicyError);
    await expect(guarded.readFile("src/a.ts")).resolves.toBe("ok");
    await expect(guarded.listFiles(".")).resolves.toEqual([]);

    expect(rawCalls).toEqual(["exec:pnpm test", "write:a.txt", "read:src/a.ts", "list:."]);
  });
});
