import { env, runInDurableObject } from "cloudflare:test";
import type { MutableModels } from "@earendil-works/pi-ai";
import {
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { clearInstallationTokenCache } from "@repo/github";
import type { GitHubWritePort } from "@repo/harness";
import { StaticOnlyPolicyError } from "@repo/harness";
import { type ReviewRequest, VAULT_INSTANCE_NAME } from "@repo/orchestrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  destroyedSandboxes,
  executed,
  executedCalls,
  faux,
  type ProductionOrchestrator,
  remoteRepoFiles,
  sandboxFiles,
  sandboxTestConfig,
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

interface MockCheckRun {
  readonly id: number;
  readonly name: string;
  readonly status: "queued" | "in_progress" | "completed";
  readonly conclusion: "success" | "failure" | "timed_out" | "skipped" | "action_required" | null;
  readonly summary?: string;
}

const mockGitHub = {
  headSha: "abc123",
  baseSha: "base000",
  defaultBranch: "main",
  isFork: false,
  diff: "diff --git a/src/sum.ts b/src/sum.ts\n--- a/src/sum.ts\n+++ b/src/sum.ts\n@@ -1,1 +1,2 @@\n export const a = 1;\n+export const b = 2;\n",
  filesByRef: new Map<string, string>(),
  checkRunsBySha: new Map<string, readonly MockCheckRun[]>(),
  defaultPassingCi: true,
  tokenRequestBodies: [] as Array<string | undefined>,
  requestedContentRefs: [] as Array<{ readonly path: string; readonly ref: string }>,
};

function installMockGitHubFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const accept = new Headers(init?.headers).get("Accept") ?? "";

      if (url.endsWith("/app/installations/42/access_tokens")) {
        mockGitHub.tokenRequestBodies.push(typeof init?.body === "string" ? init.body : undefined);
        const expiresAt = new Date(Date.now() + 3600_000).toISOString();
        return Response.json({ token: "ghs_inst_42", expires_at: expiresAt }, { status: 201 });
      }

      const prMatch = /\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/.exec(url);
      if (prMatch) {
        const repo = prMatch[1] ?? "octo/repo";
        const pullNum = Number(prMatch[2]);
        if (accept.includes("v3.diff")) {
          return new Response(mockGitHub.diff, { status: 200 });
        }
        return Response.json({
          number: pullNum,
          state: "open",
          draft: false,
          title: `PR #${pullNum}`,
          body: null,
          user: { login: "alice" },
          base: {
            sha: mockGitHub.baseSha,
            ref: mockGitHub.defaultBranch,
            repo: { id: 100, full_name: repo, default_branch: mockGitHub.defaultBranch },
          },
          head: {
            sha: mockGitHub.headSha,
            ref: "feat/x",
            repo: mockGitHub.isFork
              ? { id: 200, full_name: "external/repo", default_branch: mockGitHub.defaultBranch }
              : { id: 100, full_name: repo, default_branch: mockGitHub.defaultBranch },
          },
        });
      }

      if (url.includes("/compare/")) {
        return new Response(mockGitHub.diff, { status: 200 });
      }

      if (url.includes("/pulls/") && url.includes("/files")) {
        return Response.json([
          { filename: "src/sum.ts", status: "modified", additions: 1, deletions: 0, changes: 1 },
        ]);
      }

      const contentMatch = /\/contents\/([^?]+)\?ref=(.+)$/.exec(url);
      if (contentMatch) {
        const path = decodeURIComponent(contentMatch[1] ?? "");
        const ref = decodeURIComponent(contentMatch[2] ?? "");
        mockGitHub.requestedContentRefs.push({ path, ref });
        const content = mockGitHub.filesByRef.get(`${ref}:${path}`);
        if (content === undefined) {
          return new Response("Not Found", { status: 404 });
        }
        return Response.json({
          type: "file",
          encoding: "base64",
          size: Buffer.byteLength(content, "utf-8"),
          content: Buffer.from(content, "utf-8").toString("base64"),
        });
      }

      const checkRunsMatch = /\/commits\/([^/?]+)\/check-runs/.exec(url);
      if (checkRunsMatch) {
        const sha = decodeURIComponent(checkRunsMatch[1] ?? "");
        const configured = mockGitHub.checkRunsBySha.get(sha);
        const runs =
          configured !== undefined
            ? configured
            : mockGitHub.defaultPassingCi
              ? [
                  {
                    id: 101,
                    name: "CI / test",
                    status: "completed" as const,
                    conclusion: "success" as const,
                  },
                ]
              : [];
        return Response.json({
          check_runs: runs.map((run) => ({
            id: run.id,
            name: run.name,
            head_sha: sha,
            status: run.status,
            conclusion: run.conclusion,
            app: { id: 10, slug: "github-actions" },
            output: {
              title: run.name,
              summary: run.summary ?? "",
              annotations_count: 0,
            },
          })),
        });
      }

      const suitesMatch = /\/commits\/([^/?]+)\/check-suites/.exec(url);
      if (suitesMatch) {
        const sha = decodeURIComponent(suitesMatch[1] ?? "");
        const configured = mockGitHub.checkRunsBySha.get(sha);
        const hasPending = (configured ?? []).some((run) => run.status !== "completed");
        return Response.json({
          check_suites:
            configured !== undefined || mockGitHub.defaultPassingCi
              ? [
                  {
                    id: 500,
                    head_sha: sha,
                    status: hasPending ? "in_progress" : "completed",
                    conclusion: hasPending ? null : "success",
                    app: { id: 10, slug: "github-actions" },
                  },
                ]
              : [],
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

function withHeadSha<T extends Pick<ReviewRequest, "headSha">>(req: T): T {
  mockGitHub.headSha = req.headSha;
  return req;
}

describe("ReviewOrchestrator", () => {
  beforeEach(() => {
    executed.length = 0;
    executedCalls.length = 0;
    destroyedSandboxes.length = 0;
    sandboxFiles.clear();
    remoteRepoFiles.clear();
    sandboxTestConfig.destroyFailuresRemaining = 0;
    sandboxTestConfig.destroyHangCount = 0;
    sandboxTestConfig.destroyDelayMs = 400;
    sandboxTestConfig.installDelayMs = null;
    sandboxTestConfig.hangCommand = null;
    sandboxTestConfig.checkoutTimeoutSha = null;
    sandboxTestConfig.maxLifetimeMs = null;
    sandboxTestConfig.cleanupPollMs = null;
    sandboxTestConfig.destroyRetryBaseDelayMs = null;
    sandboxTestConfig.destroyTimeoutMs = null;
    sandboxTestConfig.ciPollIntervalMs = null;
    sandboxTestConfig.ciWaitTimeoutMs = null;
    sandboxTestConfig.ciDiscoveryGraceMs = 0;
    sandboxTestConfig.managedRepoConfig = null;
    sandboxTestConfig.failTestCommands = false;
    mockGitHub.headSha = "abc123";
    mockGitHub.baseSha = "base000";
    mockGitHub.defaultBranch = "main";
    mockGitHub.isFork = false;
    mockGitHub.diff =
      "diff --git a/src/sum.ts b/src/sum.ts\n--- a/src/sum.ts\n+++ b/src/sum.ts\n@@ -1,1 +1,2 @@\n export const a = 1;\n+export const b = 2;\n";
    mockGitHub.filesByRef.clear();
    mockGitHub.checkRunsBySha.clear();
    mockGitHub.defaultPassingCi = true;
    mockGitHub.tokenRequestBodies.length = 0;
    mockGitHub.requestedContentRefs.length = 0;
    clearInstallationTokenCache();
    installMockGitHubFetch();
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

  it("同じ delivery id の再送ではレビューを二重に実行せず、破棄後のサンドボックスも再作成しない", async () => {
    faux.setResponses([fauxAssistantMessage(fauxText("問題なし"))]);
    const orchestrator = env.ORCHESTRATOR.getByName("octo/repo#2");
    const callsBefore = faux.state.callCount;

    const first = await orchestrator.start(request);
    await orchestrator.result(request.deliveryId);
    const executedAfterFirst = executed.length;
    const destroyedAfterFirst = destroyedSandboxes.length;

    const second = await orchestrator.start(request);

    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(false);
    expect(faux.state.callCount - callsBefore).toBe(1);
    expect(executed).toHaveLength(executedAfterFirst);
    expect(destroyedSandboxes).toHaveLength(destroyedAfterFirst);
  });

  it("ports().sandbox を差し替えず RUNNER RPC 経由で 4 つのツールすべてがサンドボックスに届き、完了後にサンドボックスを破棄する", async () => {
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
    const sandboxId = executedCalls[0]?.sandboxId;
    expect(sandboxId).toMatch(/^[0-9a-f]{64}$/);
    expect(destroyedSandboxes).toEqual([sandboxId]);
    expect(sandboxFiles.has(sandboxId ?? "")).toBe(false);
    expect(executed).toEqual([
      expect.stringContaining("https://github.com/octo/repo.git -- abc123"),
      "cat repro.txt",
    ]);
  });

  it("start() で最小権限トークン・checkout/install フェーズ・コンテナ再作成を用いて取得し、token をコマンド・環境変数・ファイルに残さない", async () => {
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

    // すべてのトークンがリポジトリ単位・最小権限スコープで発行され、無制限トークンは一切要求しない
    expect(mockGitHub.tokenRequestBodies).toEqual([
      JSON.stringify({
        repositories: ["repo"],
        permissions: { contents: "read", pull_requests: "read" },
      }),
      JSON.stringify({
        repositories: ["repo"],
        permissions: { checks: "read", statuses: "read" },
      }),
      JSON.stringify({ repositories: ["repo"], permissions: { contents: "read" } }),
    ]);

    expect(executed).toEqual([expect.any(String), "npm install"]);
    const checkoutCmd = executed[0] ?? "";
    const expectedBasicAuth = btoa("x-access-token:ghs_inst_42");
    expect(checkoutCmd).toContain(
      "GIT_TERMINAL_PROMPT=0 git fetch --depth 1 https://github.com/octo/repo.git -- abc123",
    );
    expect(checkoutCmd).toContain("git -c core.symlinks=false checkout -q --force FETCH_HEAD");
    expect(checkoutCmd).not.toContain("http.extraHeader");
    expect(checkoutCmd).not.toContain("ghs_inst_42");
    expect(checkoutCmd).not.toContain(expectedBasicAuth);
    expect(checkoutCmd).not.toContain("x-access-token:");
    expect(checkoutCmd).not.toMatch(/\bexport\b/);

    expect(executedCalls[0]?.options).toEqual({
      egress: {
        profile: "checkout",
        repository: "octo/repo",
        githubToken: "ghs_inst_42",
        resetContainer: true,
      },
    });
    expect(executedCalls[1]?.options).toEqual({
      egress: { profile: "install" },
    });

    for (const files of sandboxFiles.values()) {
      for (const [path, content] of files.entries()) {
        expect(path).not.toContain("ghs_inst_42");
        expect(content).not.toContain("ghs_inst_42");
        expect(content).not.toContain(expectedBasicAuth);
      }
    }
  });

  it("レビュー完了後はサンドボックスを破棄し、次回は同じ head でもクリーンに再取得して作業ファイルを残さず、head 更新時も取り直す", async () => {
    remoteRepoFiles.set("octo/repo@sha-v1", { "src/sum.ts": "v1\n" });
    remoteRepoFiles.set("octo/repo@sha-v2", { "src/sum.ts": "v2\n" });
    const readOutputs: Array<{ isError: boolean; text: string }> = [];

    const captureLastRead: FauxResponseStep = (context) => {
      const lastToolResult = [...context.messages].reverse().find((m) => m.role === "toolResult");
      const text =
        lastToolResult?.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("") ?? "";
      readOutputs.push({ isError: lastToolResult?.isError ?? false, text });
      return fauxAssistantMessage(fauxText(`read:${text.trim()}`));
    };

    const orchestrator = env.ORCHESTRATOR.getByName("octo/repo#7");

    // 1 回目: sha-v1 をチェックアウトし、作業ファイル repro.txt を作った後、完了時にサンドボックスを破棄
    faux.setResponses([
      toolCall("write_file", { path: "repro.txt", content: "local-repro" }),
      toolCall("read_file", { path: "src/sum.ts" }),
      captureLastRead,
    ]);
    await orchestrator.start(
      withHeadSha({ ...request, deliveryId: "del-v1-a", headSha: "sha-v1" }),
    );
    await orchestrator.result("del-v1-a");
    expect(executed).toHaveLength(1);
    expect(destroyedSandboxes).toHaveLength(1);
    expect(readOutputs).toEqual([{ isError: false, text: "v1\n" }]);

    // 2 回目: 完了後の別 delivery → 破棄済みのため再取得され、前回の作業ファイル repro.txt は残らない
    faux.setResponses([toolCall("read_file", { path: "repro.txt" }), captureLastRead]);
    await orchestrator.start(
      withHeadSha({ ...request, deliveryId: "del-v1-b", headSha: "sha-v1" }),
    );
    await orchestrator.result("del-v1-b");
    expect(executed).toHaveLength(2);
    expect(destroyedSandboxes).toHaveLength(2);
    expect(readOutputs[1]?.isError).toBe(true);
    expect(readOutputs[1]?.text).toContain("ENOENT: repro.txt");

    // 3 回目: sha-v2 に更新 → 取り直され、src/sum.ts が v2 になり、完了後に再び破棄される
    faux.setResponses([toolCall("read_file", { path: "src/sum.ts" }), captureLastRead]);
    await orchestrator.start(withHeadSha({ ...request, deliveryId: "del-v2", headSha: "sha-v2" }));
    await orchestrator.result("del-v2");
    expect(executed).toHaveLength(3);
    expect(executed[2]).toContain("https://github.com/octo/repo.git -- sha-v2");
    expect(readOutputs[2]).toEqual({ isError: false, text: "v2\n" });
    expect(destroyedSandboxes).toHaveLength(3);
    expect(sandboxFiles.size).toBe(0);
  });

  it("チェックアウト失敗時はトークンをマスクして例外を投げ、次回は再取得を試みる", async () => {
    const stub = env.ORCHESTRATOR.getByName("octo/repo#8");
    const expectedBasicAuth = btoa("x-access-token:ghs_inst_42");

    await runInDurableObject(stub, async (instance) => {
      const orchestrator = instance as ProductionOrchestrator;
      await expect(
        orchestrator.start(
          withHeadSha({ ...request, deliveryId: "del-fail", headSha: "fail-sha" }),
        ),
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
    const receipt = await stub.start(withHeadSha({ ...request, deliveryId: "del-recover" }));
    const result = await stub.result("del-recover");
    expect(receipt.accepted).toBe(true);
    expect(result).toMatchObject({ status: "done", text: "復旧" });
  });

  it.each([
    {
      label: "pnpm (packageManager 指定)",
      pullNumber: 901,
      sha: "sha-pnpm",
      files: {
        "package.json": JSON.stringify({
          name: "pnpm-app",
          packageManager: "pnpm@11.25.0",
          scripts: { test: "vitest run", typecheck: "tsc --noEmit" },
        }),
        "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
      },
      expectedInstall: "corepack pnpm@11.25.0 install --frozen-lockfile",
      expectedHint:
        "テストコマンドの候補: corepack pnpm@11.25.0 test, corepack pnpm@11.25.0 run typecheck",
      testCmd: "corepack pnpm@11.25.0 test",
    },
    {
      label: "yarn (lockfile のみ)",
      pullNumber: 902,
      sha: "sha-yarn",
      files: {
        "package.json": JSON.stringify({
          name: "yarn-app",
          scripts: { test: "jest" },
        }),
        "yarn.lock": "# yarn lockfile v1\n",
      },
      expectedInstall: "yarn install --frozen-lockfile",
      expectedHint: "テストコマンドの候補: yarn test",
      testCmd: "yarn test",
    },
    {
      label: "yarn v4 (packageManager 指定)",
      pullNumber: 904,
      sha: "sha-yarn4",
      files: {
        "package.json": JSON.stringify({
          name: "yarn4-app",
          packageManager: "yarn@4.5.0",
          scripts: { test: "vitest run" },
        }),
        "yarn.lock": "__metadata:\n  version: 8\n",
      },
      expectedInstall: "corepack yarn@4.5.0 install --frozen-lockfile",
      expectedHint: "テストコマンドの候補: corepack yarn@4.5.0 test",
      testCmd: "corepack yarn@4.5.0 test",
    },
    {
      label: "npm",
      pullNumber: 903,
      sha: "sha-npm",
      files: {
        "package.json": JSON.stringify({
          name: "npm-app",
          scripts: { test: "node --test", "test:unit": "node --test src/" },
        }),
        "package-lock.json": '{"lockfileVersion":3}\n',
      },
      expectedInstall: "npm ci",
      expectedHint: "テストコマンドの候補: npm test, npm run test:unit",
      testCmd: "npm test",
    },
    {
      label: "Python (uv.lock)",
      pullNumber: 905,
      sha: "sha-py-uv",
      files: {
        "pyproject.toml": '[project]\nname = "py-app"\ndependencies = ["pytest"]\n',
        "uv.lock": "version = 1\n",
      },
      expectedInstall: "uv sync --frozen",
      expectedHint: "テストコマンドの候補: uv run --offline --no-sync pytest",
      testCmd: "uv run --offline --no-sync pytest",
    },
    {
      label: "Python (requirements.txt)",
      pullNumber: 906,
      sha: "sha-py-req",
      files: {
        "requirements.txt": "pytest==8.3.0\n",
      },
      expectedInstall:
        "uv venv .venv && uv pip install --python .venv/bin/python -r requirements.txt",
      expectedHint: "テストコマンドの候補: .venv/bin/pytest",
      testCmd: ".venv/bin/pytest",
    },
    {
      label: "Go (go.mod)",
      pullNumber: 907,
      sha: "sha-go",
      files: {
        "go.mod": "module example.com/app\n\ngo 1.24\n",
      },
      expectedInstall: "go mod download",
      expectedHint: "テストコマンドの候補: go test ./..., go vet ./...",
      testCmd: "go test ./...",
    },
    {
      label: "Rust (Cargo.toml + Cargo.lock)",
      pullNumber: 908,
      sha: "sha-rust",
      files: {
        "Cargo.toml": '[package]\nname = "core"\nversion = "0.1.0"\n',
        "Cargo.lock": "# lock\n",
      },
      expectedInstall: "cargo fetch --locked",
      expectedHint:
        "テストコマンドの候補: cargo test --offline, cargo clippy --offline --all-targets",
      testCmd: "cargo test --offline",
    },
  ])(
    "各エコシステムのプロジェクト ($label) で依存をインストールし、テストコマンド候補をモデルに示して exec からテストを実行できる",
    async ({ pullNumber, sha, files, expectedInstall, expectedHint, testCmd }) => {
      remoteRepoFiles.set(`octo/repo@${sha}`, files);
      const userPrompts: string[] = [];
      const execOutputs: Array<{ isError: boolean; text: string }> = [];

      faux.setResponses([
        (context) => {
          const lastUser = [...context.messages].reverse().find((m) => m.role === "user");
          const promptText =
            typeof lastUser?.content === "string"
              ? lastUser.content
              : (lastUser?.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("") ??
                "");
          userPrompts.push(promptText);
          return toolCall("exec", { command: testCmd });
        },
        (context) => {
          const lastTool = [...context.messages].reverse().find((m) => m.role === "toolResult");
          const text =
            lastTool?.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("") ?? "";
          execOutputs.push({ isError: lastTool?.isError ?? true, text });
          return fauxAssistantMessage(fauxText("テスト成功"));
        },
      ]);

      const orchestrator = env.ORCHESTRATOR.getByName(`octo/repo#${pullNumber}`);
      await orchestrator.start(
        withHeadSha({
          ...request,
          deliveryId: `del-${sha}-1`,
          pullNumber,
          headSha: sha,
        }),
      );
      const result = await orchestrator.result(`del-${sha}-1`);

      expect(result).toMatchObject({ status: "done", text: "テスト成功" });
      expect(executed).toEqual([
        expect.stringContaining(`https://github.com/octo/repo.git -- ${sha}`),
        expectedInstall,
        testCmd,
      ]);
      expect(executedCalls.map((call) => call.options?.egress?.profile)).toEqual([
        "checkout",
        "install",
        undefined,
      ]);
      expect(userPrompts[0]).toContain(expectedHint);
      expect(execOutputs).toEqual([
        {
          isError: false,
          text: `exit code: 0\n--- stdout ---\nPASS (${testCmd})`,
        },
      ]);

      // 1 回目完了後はサンドボックスが破棄されており、同じ headSha の別 delivery でもクリーンに再構築してテストコマンド候補を提示する
      expect(destroyedSandboxes).toHaveLength(1);
      faux.setResponses([
        (context) => {
          const lastUser = [...context.messages].reverse().find((m) => m.role === "user");
          const promptText =
            typeof lastUser?.content === "string"
              ? lastUser.content
              : (lastUser?.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("") ??
                "");
          userPrompts.push(promptText);
          return fauxAssistantMessage(fauxText("2回目完了"));
        },
      ]);
      await orchestrator.start(
        withHeadSha({
          ...request,
          deliveryId: `del-${sha}-2`,
          pullNumber,
          headSha: sha,
        }),
      );
      await orchestrator.result(`del-${sha}-2`);
      expect(executed).toHaveLength(5);
      expect(destroyedSandboxes).toHaveLength(2);
      expect(userPrompts[1]).toContain(expectedHint);
    },
  );

  it("依存インストール失敗時は例外を投げて checked_out_sha を残さず、次回リクエストで再取得・再インストールを試みる", async () => {
    remoteRepoFiles.set("octo/repo@sha-ok", {
      "package.json": JSON.stringify({ name: "app", scripts: { test: "vitest run" } }),
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    });
    remoteRepoFiles.set("octo/repo@sha-broken-install", {
      "package.json": JSON.stringify({ name: "fail-install", scripts: { test: "vitest run" } }),
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    });

    const stub = env.ORCHESTRATOR.getByName("octo/repo#910");

    // 1. まず sha-ok で成功させる
    faux.setResponses([fauxAssistantMessage(fauxText("ok-1"))]);
    await stub.start(
      withHeadSha({ ...request, deliveryId: "del-ok-1", pullNumber: 910, headSha: "sha-ok" }),
    );
    await stub.result("del-ok-1");
    expect(executed).toHaveLength(2);

    // 2. sha-broken-install で依存インストールが失敗 → コンテナ即破棄＆checked_out_sha クリア
    await runInDurableObject(stub, async (instance) => {
      const orchestrator = instance as ProductionOrchestrator;
      await expect(
        orchestrator.start(
          withHeadSha({
            ...request,
            deliveryId: "del-broken",
            pullNumber: 910,
            headSha: "sha-broken-install",
          }),
        ),
      ).rejects.toThrow(
        'failed to install dependencies with "pnpm install --frozen-lockfile" (exit 1): ERR_INSTALL_FAILED: registry error',
      );
    });
    expect(destroyedSandboxes).toHaveLength(2);
    expect(sandboxFiles.size).toBe(0);

    // 3. 再び sha-ok に戻した際、古い checked_out_sha が残っていないため再取得・再インストールが走る
    faux.setResponses([fauxAssistantMessage(fauxText("ok-2"))]);
    await stub.start(
      withHeadSha({ ...request, deliveryId: "del-ok-2", pullNumber: 910, headSha: "sha-ok" }),
    );
    const result = await stub.result("del-ok-2");
    expect(result).toMatchObject({ status: "done", text: "ok-2" });
    expect(executed).toHaveLength(6);
    expect(destroyedSandboxes).toHaveLength(3);
  });

  it("依存インストール中に同じ head への start() が重なった場合、実行中の Promise を共有して node_modules を壊さず、全完了後に 1 回破棄する", async () => {
    remoteRepoFiles.set("octo/repo@sha-concurrent", {
      "package.json": JSON.stringify({ name: "concurrent-app", scripts: { test: "vitest run" } }),
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    });

    const toolOutputs: string[] = [];
    faux.setResponses([
      toolCall("exec", { command: "pnpm test" }),
      (context) => {
        const lastTool = [...context.messages].reverse().find((m) => m.role === "toolResult");
        toolOutputs.push(
          lastTool?.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("") ?? "",
        );
        return fauxAssistantMessage(fauxText("1回目完了"));
      },
      toolCall("exec", { command: "pnpm test" }),
      (context) => {
        const lastTool = [...context.messages].reverse().find((m) => m.role === "toolResult");
        toolOutputs.push(
          lastTool?.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("") ?? "",
        );
        return fauxAssistantMessage(fauxText("2回目完了"));
      },
    ]);

    const orchestrator = env.ORCHESTRATOR.getByName("octo/repo#920");
    mockGitHub.headSha = "sha-concurrent";

    // 同じ head に対して 2 つの start() を同時に呼び出す
    const [r1, r2] = await Promise.all([
      orchestrator.start({
        ...request,
        deliveryId: "del-conc-1",
        pullNumber: 920,
        headSha: "sha-concurrent",
      }),
      orchestrator.start({
        ...request,
        deliveryId: "del-conc-2",
        pullNumber: 920,
        headSha: "sha-concurrent",
      }),
    ]);

    if (r1.accepted) {
      await orchestrator.result("del-conc-1");
    }
    if (r2.accepted) {
      await orchestrator.result("del-conc-2");
    }

    // チェックアウトと依存インストールは 1 回ずつしか走らず、両方ともインストール済み環境で実行でき、全完了後に 1 回破棄される
    const checkoutCalls = executed.filter((cmd) => cmd.includes("git init -q"));
    const installCalls = executed.filter((cmd) => cmd === "pnpm install --frozen-lockfile");
    expect(checkoutCalls).toHaveLength(1);
    expect(installCalls).toHaveLength(1);
    expect(toolOutputs).toEqual([
      "exit code: 0\n--- stdout ---\nPASS (pnpm test)",
      "exit code: 0\n--- stdout ---\nPASS (pnpm test)",
    ]);
    expect(destroyedSandboxes).toHaveLength(1);
    expect(sandboxFiles.size).toBe(0);
  });

  it("旧スキーマ（test_commands_json 列なし）から移行した際は既存の checked_out_sha キャッシュを無効化し、同じ head でも依存インストールとコマンド検出を実行する", async () => {
    remoteRepoFiles.set("octo/repo@sha-legacy", {
      "package.json": JSON.stringify({
        name: "legacy-app",
        scripts: { test: "vitest run" },
      }),
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    });

    const stub = env.ORCHESTRATOR.getByName("octo/repo#930");

    // 旧スキーマの状態（test_commands_json 列がなく、checked_out_sha が既に保存されている状態）を再現
    await runInDurableObject(stub, async (instance) => {
      const sql = (instance as unknown as { ctx: DurableObjectState }).ctx.storage.sql;
      sql.exec("DROP TABLE IF EXISTS review_target");
      sql.exec(`CREATE TABLE review_target (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        repository TEXT NOT NULL,
        pull_number INTEGER NOT NULL,
        head_sha TEXT NOT NULL,
        installation_id INTEGER NOT NULL,
        checked_out_sha TEXT
      )`);
      sql.exec(
        "INSERT INTO review_target (id, repository, pull_number, head_sha, installation_id, checked_out_sha) VALUES (1, 'octo/repo', 930, 'sha-legacy', 42, 'sha-legacy')",
      );
    });

    const userPrompts: string[] = [];
    faux.setResponses([
      (context) => {
        const lastUser = [...context.messages].reverse().find((m) => m.role === "user");
        const promptText =
          typeof lastUser?.content === "string"
            ? lastUser.content
            : (lastUser?.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("") ??
              "");
        userPrompts.push(promptText);
        return fauxAssistantMessage(fauxText("移行後レビュー完了"));
      },
    ]);

    await stub.start(
      withHeadSha({
        ...request,
        deliveryId: "del-legacy-1",
        pullNumber: 930,
        headSha: "sha-legacy",
      }),
    );
    const result = await stub.result("del-legacy-1");

    expect(result).toMatchObject({ status: "done", text: "移行後レビュー完了" });
    expect(executed).toEqual([
      expect.stringContaining("https://github.com/octo/repo.git -- sha-legacy"),
      "pnpm install --frozen-lockfile",
    ]);
    expect(userPrompts[0]).toContain("テストコマンドの候補: pnpm test");
  });

  it("Read/Write 責務分離: Agent ツールは Read 専用トークンの get_diff のみ実行でき、Write 系は Orchestrator 専用 githubWritePort() から最小権限トークンで実行する", async () => {
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
        const accept = headers.get("Accept") ?? "";
        githubCalls.push({
          url,
          method: init?.method,
          auth: headers.get("Authorization") ?? undefined,
          accept: accept || undefined,
          body: typeof init?.body === "string" ? init.body : undefined,
        });
        if (url.endsWith("/app/installations/99/access_tokens")) {
          const expiresAt = new Date(Date.now() + 3600_000).toISOString();
          const reqBody = typeof init?.body === "string" ? init.body : "";
          const token = reqBody.includes('"write"')
            ? "ghs_write_token_99"
            : reqBody.includes('"checks"')
              ? "ghs_checks_token_99"
              : "ghs_read_token_99";
          return Response.json({ token, expires_at: expiresAt }, { status: 201 });
        }
        if (url.endsWith("/repos/octo/repo/pulls/5")) {
          if (accept.includes("v3.diff")) {
            return new Response("diff --git a/index.ts b/index.ts\n+const x = 1;", { status: 200 });
          }
          return Response.json({
            number: 5,
            state: "open",
            draft: false,
            title: "PR #5",
            body: null,
            user: { login: "alice" },
            base: {
              sha: "base555",
              ref: "main",
              repo: { id: 100, full_name: "octo/repo", default_branch: "main" },
            },
            head: {
              sha: "sha555",
              ref: "feat/5",
              repo: { id: 100, full_name: "octo/repo", default_branch: "main" },
            },
          });
        }
        if (url.includes("/compare/")) {
          return new Response("diff --git a/index.ts b/index.ts\n+const x = 1;", { status: 200 });
        }
        if (url.includes("/contents/")) {
          return new Response("Not Found", { status: 404 });
        }
        if (url.includes("/check-runs")) {
          return Response.json({
            check_runs: [
              {
                id: 10,
                name: "CI / test",
                head_sha: "sha555",
                status: "completed",
                conclusion: "success",
                app: { id: 10, slug: "github-actions" },
                output: { title: "ok", summary: "", annotations_count: 0 },
              },
            ],
          });
        }
        if (url.includes("/check-suites")) {
          return Response.json({
            check_suites: [
              {
                id: 1,
                head_sha: "sha555",
                status: "completed",
                conclusion: "success",
                app: { id: 10, slug: "github-actions" },
              },
            ],
          });
        }
        if (url.includes("/status")) {
          return Response.json({ sha: "sha555", state: "success", statuses: [] });
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
      (context) => {
        for (const msg of context.messages) {
          if (msg.role === "toolResult") {
            const text = msg.content
              .flatMap((part) => (part.type === "text" ? [part.text] : []))
              .join("");
            toolResults.push({ toolName: msg.toolName, isError: msg.isError, text });
          }
        }
        return fauxAssistantMessage(fauxText("Read ツールのみ実行完了"));
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

    expect(result).toMatchObject({ status: "done", text: "Read ツールのみ実行完了" });
    expect(toolResults).toEqual([
      {
        toolName: "get_diff",
        isError: false,
        text: "diff --git a/index.ts b/index.ts\n+const x = 1;",
      },
    ]);
    for (const r of toolResults) {
      expect(r.text).not.toContain("ghs_read_token_99");
      expect(r.text).not.toContain("ghs_write_token_99");
    }

    // ports().github に Write 系が存在せず、Orchestrator 専用 githubWritePort() からのみ Write トークンで投稿・解決できる
    await runInDurableObject(orchestrator, async (instance) => {
      const typed = instance as unknown as {
        ports(): { github: Record<string, unknown> };
        githubWritePort(): GitHubWritePort;
      };
      expect("postReview" in typed.ports().github).toBe(false);
      expect("resolveThread" in typed.ports().github).toBe(false);

      const writePort = typed.githubWritePort();
      await writePort.resolveThread("PRRT_kwDO999");
      const posted = await writePort.postReview({
        commitId: "sha555",
        event: "COMMENT",
        body: "すべて問題ありません。",
        comments: [{ path: "index.ts", line: 1, body: "確認済み" }],
      });
      expect(posted).toEqual({ id: 501 });
    });

    const tokenBodies = githubCalls
      .filter((call) => call.url.endsWith("/app/installations/99/access_tokens"))
      .map((call) => call.body);
    expect(tokenBodies).toEqual([
      JSON.stringify({
        repositories: ["repo"],
        permissions: { contents: "read", pull_requests: "read" },
      }),
      JSON.stringify({
        repositories: ["repo"],
        permissions: { checks: "read", statuses: "read" },
      }),
      JSON.stringify({ repositories: ["repo"], permissions: { contents: "read" } }),
      JSON.stringify({ repositories: ["repo"], permissions: { pull_requests: "write" } }),
    ]);

    expect(githubCalls.find((c) => c.url.endsWith("/pulls/5/reviews"))).toMatchObject({
      auth: "Bearer ghs_write_token_99",
      body: JSON.stringify({
        body: "すべて問題ありません。",
        event: "COMMENT",
        commit_id: "sha555",
        comments: [{ path: "index.ts", line: 1, side: "RIGHT", body: "確認済み" }],
      }),
    });
  });

  it("チェックアウトがタイムアウトした場合はトークンをマスクしてタイムアウトエラーを投げ、コンテナを即破棄する", async () => {
    sandboxTestConfig.checkoutTimeoutSha = "timeout-sha";
    const stub = env.ORCHESTRATOR.getByName("octo/repo#940");
    const expectedBasicAuth = btoa("x-access-token:ghs_inst_42");

    await runInDurableObject(stub, async (instance) => {
      const orchestrator = instance as ProductionOrchestrator;
      await expect(
        orchestrator.start(
          withHeadSha({
            ...request,
            deliveryId: "del-checkout-timeout",
            pullNumber: 940,
            headSha: "timeout-sha",
          }),
        ),
      ).rejects.toSatisfy((error: unknown) => {
        const msg = error instanceof Error ? error.message : String(error);
        expect(msg).toContain("timed out while checking out octo/repo@timeout-sha (exit 124)");
        expect(msg).toContain("[REDACTED]");
        expect(msg).not.toContain("ghs_inst_42");
        expect(msg).not.toContain(expectedBasicAuth);
        return true;
      });
    });

    expect(destroyedSandboxes).toHaveLength(1);
    expect(sandboxFiles.size).toBe(0);
  });

  it("最大生存時間 (TTL) を超過すると実行中のレビューをデッドロックせず中断・強制破棄し、以後のゾンビ再生成も防ぐ", async () => {
    sandboxTestConfig.maxLifetimeMs = 150;
    sandboxTestConfig.cleanupPollMs = 150;
    sandboxTestConfig.hangCommand = "sleep 999";

    faux.setResponses([
      toolCall("exec", { command: "sleep 999" }),
      fauxAssistantMessage(fauxText("到達しないはず")),
    ]);

    const stub = env.ORCHESTRATOR.getByName("octo/repo#950");
    await stub.start(
      withHeadSha({
        ...request,
        deliveryId: "del-ttl-expire",
        pullNumber: 950,
        headSha: "sha-ttl",
      }),
    );

    await vi.waitFor(() => {
      expect(executed).toContain("sleep 999");
    });

    const outcome = await stub.result("del-ttl-expire");
    expect(outcome.status).toBe("unanswered");
    await vi.waitFor(() => {
      expect(destroyedSandboxes).toHaveLength(1);
    });
    expect(sandboxFiles.size).toBe(0);

    await runInDurableObject(stub, async (instance) => {
      const ports = (
        instance as unknown as {
          ports(): { sandbox: { exec(cmd: string): Promise<unknown> } };
        }
      ).ports();
      await expect(ports.sandbox.exec("echo zombie")).rejects.toThrow(
        "sandbox is no longer active; it has already been destroyed",
      );
    });
    expect(executed).not.toContain("echo zombie");
  });

  it("DO 退避で完了監視が失われたアイドル状態のサンドボックスを Lifecycle ジョブ (onJob) で回収する", async () => {
    faux.setResponses([fauxAssistantMessage(fauxText("完了済み"))]);
    const stub = env.ORCHESTRATOR.getByName("octo/repo#960");
    await stub.start(
      withHeadSha({
        ...request,
        deliveryId: "del-recovery",
        pullNumber: 960,
        headSha: "sha-rec",
      }),
    );
    await stub.result("del-recovery");
    expect(destroyedSandboxes).toHaveLength(1);

    await runInDurableObject(stub, async (instance) => {
      const orchestrator = instance as unknown as {
        ctx: DurableObjectState;
        lifecycle: {
          jobs: {
            push(opts: {
              id: string;
              fn: string;
              time: number;
              payload: unknown;
              singleflight?: boolean;
            }): Promise<unknown>;
          };
        };
      };
      orchestrator.ctx.storage.sql.exec(
        "UPDATE review_target SET sandbox_active = 1, sandbox_generation = 9, sandbox_expires_at = ? WHERE id = 1",
        Date.now() + 600_000,
      );
      await orchestrator.lifecycle.jobs.push({
        id: "sandbox-cleanup",
        fn: "cleanupSandbox",
        time: Date.now() + 40,
        payload: { generation: 9 },
        singleflight: true,
      });
    });

    await vi.waitFor(
      () => {
        expect(destroyedSandboxes).toHaveLength(2);
      },
      { timeout: 2_000 },
    );
  });

  it("完了後の destroy() が一時失敗してもレビュー結果は正常に返し、Lifecycle ジョブのバックオフ再試行で確実に破棄する", async () => {
    sandboxTestConfig.destroyFailuresRemaining = 1;
    sandboxTestConfig.destroyRetryBaseDelayMs = 150;

    faux.setResponses([fauxAssistantMessage(fauxText("レビュー自体は成功"))]);
    const stub = env.ORCHESTRATOR.getByName("octo/repo#970");
    await stub.start(
      withHeadSha({
        ...request,
        deliveryId: "del-destroy-retry",
        pullNumber: 970,
        headSha: "sha-retry",
      }),
    );

    const outcome = await stub.result("del-destroy-retry");
    expect(outcome).toMatchObject({ status: "done", text: "レビュー自体は成功" });
    expect(destroyedSandboxes).toHaveLength(0);

    await vi.waitFor(
      () => {
        expect(destroyedSandboxes).toHaveLength(1);
      },
      { timeout: 2_000 },
    );
    expect(sandboxFiles.size).toBe(0);
  });

  it("同一 head への並行 start() が共有セットアップで失敗した場合でも即座にコンテナを破棄する", async () => {
    remoteRepoFiles.set("octo/repo@sha-concurrent-fail", {
      "package.json": JSON.stringify({ name: "fail-install", scripts: { test: "vitest run" } }),
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    });

    const stub = env.ORCHESTRATOR.getByName("octo/repo#975");
    mockGitHub.headSha = "sha-concurrent-fail";
    await runInDurableObject(stub, async (instance) => {
      const orchestrator = instance as ProductionOrchestrator;
      const results = await Promise.allSettled([
        orchestrator.start({
          ...request,
          deliveryId: "del-conc-fail-1",
          pullNumber: 975,
          headSha: "sha-concurrent-fail",
        }),
        orchestrator.start({
          ...request,
          deliveryId: "del-conc-fail-2",
          pullNumber: 975,
          headSha: "sha-concurrent-fail",
        }),
      ]);

      expect(results[0]?.status).toBe("rejected");
      expect(results[1]?.status).toBe("rejected");
    });

    expect(destroyedSandboxes).toHaveLength(1);
    expect(sandboxFiles.size).toBe(0);
  });

  it("pendingDestroy バックオフ予約中に result() を再呼び出ししてもリトライ回数やバックオフを巻き戻さない", async () => {
    sandboxTestConfig.destroyFailuresRemaining = 1;
    sandboxTestConfig.destroyRetryBaseDelayMs = 250;

    faux.setResponses([fauxAssistantMessage(fauxText("完了"))]);
    const stub = env.ORCHESTRATOR.getByName("octo/repo#976");
    await stub.start(
      withHeadSha({
        ...request,
        deliveryId: "del-no-rewind",
        pullNumber: 976,
        headSha: "sha-no-rewind",
      }),
    );

    await stub.result("del-no-rewind");
    expect(destroyedSandboxes).toHaveLength(0);

    await stub.result("del-no-rewind");
    expect(destroyedSandboxes).toHaveLength(0);

    await vi.waitFor(
      () => {
        expect(destroyedSandboxes).toHaveLength(1);
      },
      { timeout: 2_000 },
    );
  });

  it("destroy() が最大リトライ回数を超えて失敗し続けても無限ループせず sandbox_active = 0 で収束する", async () => {
    sandboxTestConfig.destroyFailuresRemaining = 10;
    sandboxTestConfig.destroyRetryBaseDelayMs = 10;

    faux.setResponses([fauxAssistantMessage(fauxText("完了"))]);
    const stub = env.ORCHESTRATOR.getByName("octo/repo#977");
    await stub.start(
      withHeadSha({
        ...request,
        deliveryId: "del-max-retry",
        pullNumber: 977,
        headSha: "sha-max-retry",
      }),
    );

    await stub.result("del-max-retry");
    expect(destroyedSandboxes).toHaveLength(0);

    await vi.waitFor(
      async () => {
        const active = await runInDurableObject(stub, (instance) => {
          const sql = (instance as unknown as { ctx: DurableObjectState }).ctx.storage.sql;
          return sql
            .exec<{ sandbox_active: number }>(
              "SELECT sandbox_active FROM review_target WHERE id = 1",
            )
            .toArray()[0]?.sandbox_active;
        });
        expect(active).toBe(0);
      },
      { timeout: 3_000 },
    );
  });

  it("破棄 RPC がハングしても上限時間で打ち切り、次回 start() を停止させず再試行ジョブで回収する", async () => {
    sandboxTestConfig.destroyHangCount = 1;
    sandboxTestConfig.destroyDelayMs = 500;
    sandboxTestConfig.destroyTimeoutMs = 40;
    sandboxTestConfig.destroyRetryBaseDelayMs = 120;

    faux.setResponses([fauxAssistantMessage(fauxText("1回目完了"))]);
    const stub1 = env.ORCHESTRATOR.getByName("octo/repo#978");
    await stub1.start(
      withHeadSha({
        ...request,
        deliveryId: "del-hang-retry",
        pullNumber: 978,
        headSha: "sha-hang-1",
      }),
    );

    const startedWait = Date.now();
    const res1 = await stub1.result("del-hang-retry");
    expect(res1).toMatchObject({ status: "done", text: "1回目完了" });
    expect(Date.now() - startedWait).toBeLessThan(350);
    expect(destroyedSandboxes).toHaveLength(0);

    await vi.waitFor(
      () => {
        expect(destroyedSandboxes).toHaveLength(1);
      },
      { timeout: 2_000 },
    );

    sandboxTestConfig.destroyHangCount = 1;
    faux.setResponses([
      fauxAssistantMessage(fauxText("先行完了")),
      fauxAssistantMessage(fauxText("後続完了")),
    ]);
    const stub2 = env.ORCHESTRATOR.getByName("octo/repo#979");
    await stub2.start(
      withHeadSha({
        ...request,
        deliveryId: "del-hang-first",
        pullNumber: 979,
        headSha: "sha-hang-a",
      }),
    );
    const firstOutcome = await stub2.result("del-hang-first");
    expect(firstOutcome).toMatchObject({ status: "done", text: "先行完了" });

    const secondStartAt = Date.now();
    await stub2.start(
      withHeadSha({
        ...request,
        deliveryId: "del-hang-second",
        pullNumber: 979,
        headSha: "sha-hang-b",
      }),
    );
    const secondOutcome = await stub2.result("del-hang-second");
    expect(secondOutcome).toMatchObject({ status: "done", text: "後続完了" });
    expect(Date.now() - secondStartAt).toBeLessThan(350);
  });

  it("後片付けの事前・事後処理（ジョブ登録/解除）が例外を投げてもレビュー結果や元のセットアップエラーを失わず次回開始も成功する", async () => {
    const stub = env.ORCHESTRATOR.getByName("octo/repo#980");

    faux.setResponses([
      fauxAssistantMessage(fauxText("完了結果1")),
      fauxAssistantMessage(fauxText("完了結果2")),
    ]);
    await stub.start(
      withHeadSha({
        ...request,
        deliveryId: "del-cleanup-err-1",
        pullNumber: 980,
        headSha: "sha-err-1",
      }),
    );
    await runInDurableObject(stub, (instance) => {
      const lifecycle = (
        instance as unknown as {
          lifecycle: {
            jobs: {
              push(opts: unknown): Promise<unknown>;
              cancel(id: string): Promise<boolean>;
              get(id: string): unknown;
              list(): unknown[];
              reschedule(id: string, time: number): Promise<boolean>;
              rearm(): Promise<void>;
            };
          };
        }
      ).lifecycle;
      const origJobs = lifecycle.jobs;
      let failedOnce = false;
      Object.defineProperty(lifecycle, "jobs", {
        configurable: true,
        get() {
          return {
            ...origJobs,
            cancel: async (id: string) => {
              if (!failedOnce) {
                failedOnce = true;
                throw new Error("simulated job cancel error");
              }
              return origJobs.cancel(id);
            },
          };
        },
      });
    });

    const res1 = await stub.result("del-cleanup-err-1");
    expect(res1).toMatchObject({ status: "done", text: "完了結果1" });

    await stub.start(
      withHeadSha({
        ...request,
        deliveryId: "del-cleanup-err-2",
        pullNumber: 980,
        headSha: "sha-err-2",
      }),
    );
    const res2 = await stub.result("del-cleanup-err-2");
    expect(res2).toMatchObject({ status: "done", text: "完了結果2" });

    remoteRepoFiles.set("octo/repo@sha-setup-err-cleanup-err", {
      "package.json": JSON.stringify({ name: "fail-install", scripts: { test: "vitest run" } }),
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    });
    const stubSetup = env.ORCHESTRATOR.getByName("octo/repo#981");
    await runInDurableObject(stubSetup, async (instance) => {
      const orchestrator = instance as ProductionOrchestrator;
      const lifecycle = (
        instance as unknown as {
          lifecycle: {
            jobs: {
              push(opts: unknown): Promise<unknown>;
              cancel(id: string): Promise<boolean>;
              get(id: string): unknown;
              list(): unknown[];
              reschedule(id: string, time: number): Promise<boolean>;
              rearm(): Promise<void>;
            };
          };
        }
      ).lifecycle;
      const origJobs = lifecycle.jobs;
      let pushCalls = 0;
      Object.defineProperty(lifecycle, "jobs", {
        configurable: true,
        get() {
          return {
            ...origJobs,
            push: async (opts: unknown) => {
              pushCalls += 1;
              if (pushCalls === 2) {
                throw new Error("simulated cleanup push error");
              }
              return origJobs.push(opts);
            },
          };
        },
      });

      await expect(
        orchestrator.start(
          withHeadSha({
            ...request,
            deliveryId: "del-setup-err-preserve",
            pullNumber: 981,
            headSha: "sha-setup-err-cleanup-err",
          }),
        ),
      ).rejects.toThrow(
        'failed to install dependencies with "pnpm install --frozen-lockfile" (exit 1): ERR_INSTALL_FAILED: registry error',
      );
    });
  });

  it("強制破棄の失敗後にセットアップ失敗の後片付けが走っても、予約済み pendingDestroy 再試行ジョブを解除せず回収する", async () => {
    remoteRepoFiles.set("octo/repo@sha-force-then-setup-fail", {
      "package.json": JSON.stringify({ name: "slow-app", scripts: { test: "vitest run" } }),
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    });
    sandboxTestConfig.maxLifetimeMs = 80;
    sandboxTestConfig.cleanupPollMs = 80;
    sandboxTestConfig.installDelayMs = 150;
    sandboxTestConfig.destroyFailuresRemaining = 1;
    sandboxTestConfig.destroyRetryBaseDelayMs = 150;

    const stub = env.ORCHESTRATOR.getByName("octo/repo#982");

    await runInDurableObject(stub, async (instance) => {
      const orchestrator = instance as ProductionOrchestrator;
      await expect(
        orchestrator.start(
          withHeadSha({
            ...request,
            deliveryId: "del-force-setup-race",
            pullNumber: 982,
            headSha: "sha-force-then-setup-fail",
          }),
        ),
      ).rejects.toThrow("sandbox was destroyed while preparing target");
    });

    expect(destroyedSandboxes).toHaveLength(0);
    await vi.waitFor(
      () => {
        expect(destroyedSandboxes).toHaveLength(1);
      },
      { timeout: 2_000 },
    );
  });

  describe("Step 0 / Step 1 プロトコル・static_only 強制", () => {
    it("CI 待機がタイムアウトすると Sandbox 決定論的テスト実行へフォールバックし、結果を記録してレビューへ進む", async () => {
      remoteRepoFiles.set("octo/repo@sha-timeout-fb", {
        "package.json": JSON.stringify({ name: "fb-app", scripts: { test: "vitest run" } }),
        "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
      });
      mockGitHub.checkRunsBySha.set("sha-timeout-fb", [
        { id: 1, name: "CI / test", status: "in_progress", conclusion: null },
      ]);
      sandboxTestConfig.ciPollIntervalMs = 30;
      sandboxTestConfig.ciWaitTimeoutMs = 80;

      faux.setResponses([fauxAssistantMessage(fauxText("フォールバック後にレビュー完了"))]);
      const stub = env.ORCHESTRATOR.getByName("octo/repo#1001");
      const receipt = await stub.start(
        withHeadSha({
          ...request,
          deliveryId: "del-timeout-fb",
          pullNumber: 1001,
          headSha: "sha-timeout-fb",
        }),
      );
      expect(receipt).toMatchObject({ accepted: true, stage: "awaiting_ci" });

      const outcome = await stub.result("del-timeout-fb");
      expect(outcome).toMatchObject({ status: "done", text: "フォールバック後にレビュー完了" });

      // タイムアウト後に Sandbox で checkout → install → 決定論的 pnpm test が実行されていること
      expect(executed).toEqual([
        expect.stringContaining("https://github.com/octo/repo.git -- sha-timeout-fb"),
        "pnpm install --frozen-lockfile",
        "pnpm test",
      ]);
      const state = await stub.step1Status("del-timeout-fb");
      expect(state?.testReport).toMatchObject({
        source: "sandbox",
        overallStatus: "passed",
        shouldEarlyReject: false,
      });
    });

    it("CI 失敗時に baseSha と照合し、base 既存失敗は継続、変更起因失敗は earlyRejectPolicy 3 モードに従って判定する", async () => {
      const callsBefore = faux.state.callCount;

      // 1. baseSha でも落ちている failed_preexisting -> on_test_failure でも継続
      mockGitHub.checkRunsBySha.set("sha-preexist", [
        { id: 1, name: "CI / test", status: "completed", conclusion: "failure" },
      ]);
      mockGitHub.checkRunsBySha.set("base000", [
        { id: 2, name: "CI / test", status: "completed", conclusion: "failure" },
      ]);
      faux.setResponses([fauxAssistantMessage(fauxText("既存失敗は継続"))]);
      const stubPre = env.ORCHESTRATOR.getByName("octo/repo#1002");
      await stubPre.start(
        withHeadSha({
          ...request,
          deliveryId: "del-preexist",
          pullNumber: 1002,
          headSha: "sha-preexist",
        }),
      );
      await expect(stubPre.result("del-preexist")).resolves.toMatchObject({
        status: "done",
        text: "既存失敗は継続",
      });
      const preState = await stubPre.step1Status("del-preexist");
      expect(preState?.testReport?.overallStatus).toBe("failed_preexisting");
      expect(faux.state.callCount).toBe(callsBefore + 1);

      // 2. 変更起因 test 失敗 + on_test_failure -> early_rejected（LLM 非起動・Sandbox 非起動）
      executed.length = 0;
      mockGitHub.checkRunsBySha.set("base000", [
        { id: 2, name: "CI / test", status: "completed", conclusion: "success" },
      ]);
      mockGitHub.checkRunsBySha.set("sha-reg-fail", [
        { id: 3, name: "CI / test", status: "completed", conclusion: "failure" },
      ]);
      const stubRej = env.ORCHESTRATOR.getByName("octo/repo#1003");
      const rejReceipt = await stubRej.start(
        withHeadSha({
          ...request,
          deliveryId: "del-reg-fail",
          pullNumber: 1003,
          headSha: "sha-reg-fail",
        }),
      );
      expect(rejReceipt).toMatchObject({ accepted: true, stage: "early_rejected" });
      await expect(stubRej.result("del-reg-fail")).resolves.toMatchObject({
        status: "early_rejected",
      });
      expect(faux.state.callCount).toBe(callsBefore + 1);
      expect(executed).toHaveLength(0);

      // 3. 変更起因 test 失敗 + never -> LLM へ継続
      sandboxTestConfig.managedRepoConfig = { earlyRejectPolicy: "never" };
      faux.setResponses([fauxAssistantMessage(fauxText("never なので継続"))]);
      const stubNever = env.ORCHESTRATOR.getByName("octo/repo#1004");
      await stubNever.start(
        withHeadSha({
          ...request,
          deliveryId: "del-never",
          pullNumber: 1004,
          headSha: "sha-reg-fail",
        }),
      );
      await expect(stubNever.result("del-never")).resolves.toMatchObject({
        status: "done",
        text: "never なので継続",
      });
      const neverState = await stubNever.step1Status("del-never");
      expect(neverState?.testReport?.hasRegressionFailure).toBe(true);
      expect(neverState?.testReport?.shouldEarlyReject).toBe(false);

      // 4. default_branch の .github/review-harness.json で strict を宣言 + lint 単体失敗 -> early_rejected
      sandboxTestConfig.managedRepoConfig = null;
      mockGitHub.requestedContentRefs.length = 0;
      mockGitHub.filesByRef.set(
        "main:.github/review-harness.json",
        JSON.stringify({ earlyRejectPolicy: "strict", budgetUsd: 999 }),
      );
      mockGitHub.checkRunsBySha.set("sha-lint-fail", [
        { id: 4, name: "CI / test", status: "completed", conclusion: "success" },
        { id: 5, name: "Biome Lint", status: "completed", conclusion: "failure" },
      ]);
      const stubStrict = env.ORCHESTRATOR.getByName("octo/repo#1005");
      const strictReceipt = await stubStrict.start(
        withHeadSha({
          ...request,
          deliveryId: "del-strict-lint",
          pullNumber: 1005,
          headSha: "sha-lint-fail",
        }),
      );
      expect(strictReceipt).toMatchObject({ accepted: true, stage: "early_rejected" });
      // PR head ではなく defaultBranch ("main") のみから設定ファイルを読んでいること
      expect(
        mockGitHub.requestedContentRefs.filter((r) => r.path.includes("review-harness.json")),
      ).toEqual([{ path: ".github/review-harness.json", ref: "main" }]);
    });

    it("外部フォーク PR および ci_script_hazard 検出時は static_only を強制し、setupProject / exec / write_file を全面遮断する", async () => {
      // 1. 外部フォーク PR（CI なしでも Sandbox は一切起動しない。read_file は GitHub Contents API で読める）
      mockGitHub.isFork = true;
      mockGitHub.defaultPassingCi = false;
      mockGitHub.filesByRef.set("sha-fork-1:src/sum.ts", "export const sum = () => 42;\n");

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
          return fauxAssistantMessage(fauxText("フォーク PR 静的レビュー完了"));
        },
      ]);

      const stubFork = env.ORCHESTRATOR.getByName("octo/repo#1010");
      const forkReceipt = await stubFork.start(
        withHeadSha({
          ...request,
          deliveryId: "del-fork-1",
          pullNumber: 1010,
          headSha: "sha-fork-1",
          isFork: true,
        }),
      );
      expect(forkReceipt).toMatchObject({
        accepted: true,
        executionMode: "static_only",
        stage: "primary_review",
      });
      await expect(stubFork.result("del-fork-1")).resolves.toMatchObject({
        status: "done",
        text: "フォーク PR 静的レビュー完了",
      });
      expect(executed).toHaveLength(0);
      expect(toolResults).toEqual([
        { toolName: "read_file", isError: false, text: "export const sum = () => 42;\n" },
      ]);

      // static_only 中の exec / writeFile は StaticOnlyPolicyError で機械遮断される
      await runInDurableObject(stubFork, async (instance) => {
        const ports = (
          instance as unknown as {
            ports(): {
              sandbox: {
                exec(cmd: string): Promise<unknown>;
                writeFile(path: string, content: string): Promise<void>;
              };
            };
          }
        ).ports();
        await expect(ports.sandbox.exec("echo evil")).rejects.toThrow(StaticOnlyPolicyError);
        await expect(ports.sandbox.writeFile("a.txt", "evil")).rejects.toThrow(
          StaticOnlyPolicyError,
        );
      });
      expect(executed).toHaveLength(0);

      // 2. 内部 PR でも package.json の postinstall 改ざん (ci_script_hazard) で static_only 強制
      mockGitHub.isFork = false;
      mockGitHub.diff = [
        "diff --git a/package.json b/package.json",
        "--- a/package.json",
        "+++ b/package.json",
        "@@ -1,2 +1,3 @@",
        ' "scripts": {',
        '+  "postinstall": "node ./evil.js"',
        " }",
      ].join("\n");
      faux.setResponses([fauxAssistantMessage(fauxText("ハザード検知で静的レビュー"))]);
      const stubHaz = env.ORCHESTRATOR.getByName("octo/repo#1011");
      const hazReceipt = await stubHaz.start(
        withHeadSha({
          ...request,
          deliveryId: "del-hazard-1",
          pullNumber: 1011,
          headSha: "sha-hazard-1",
        }),
      );
      expect(hazReceipt).toMatchObject({ executionMode: "static_only" });
      await expect(stubHaz.result("del-hazard-1")).resolves.toMatchObject({
        status: "done",
        text: "ハザード検知で静的レビュー",
      });
      expect(executed).toHaveLength(0);
      const hazState = await stubHaz.step1Status("del-hazard-1");
      expect(hazState?.staticOnlyReason).toBe("ci_script_hazard");
      expect(hazState?.testReport?.executionMode).toBe("static_only");
    });

    it("遅延到着した古い headSha の webhook が進行中 awaiting_ci の新世代を破壊しない", async () => {
      mockGitHub.headSha = "sha-new-2";
      mockGitHub.checkRunsBySha.set("sha-new-2", [
        { id: 1, name: "CI / test", status: "in_progress", conclusion: null },
      ]);
      sandboxTestConfig.ciPollIntervalMs = 60_000;
      sandboxTestConfig.ciWaitTimeoutMs = 300_000;
      faux.setResponses([fauxAssistantMessage(fauxText("新世代が保護されて完了"))]);

      const stub = env.ORCHESTRATOR.getByName("octo/repo#1020");
      const newReceipt = await stub.start({
        ...request,
        deliveryId: "del-order-new",
        pullNumber: 1020,
        headSha: "sha-new-2",
      });
      expect(newReceipt).toMatchObject({ accepted: true, stage: "awaiting_ci" });

      // 古い headSha の遅延 webhook が後から到着 -> GitHub 上の最新は sha-new-2 なので stale 扱い
      const staleReceipt = await stub.start({
        ...request,
        deliveryId: "del-order-old",
        pullNumber: 1020,
        headSha: "sha-old-1",
      });
      expect(staleReceipt).toMatchObject({ accepted: false, stage: "superseded" });

      // 新世代は awaiting_ci のまま保持され、CI 完了通知でそのままレビュー完走する
      await expect(stub.step1Status("del-order-new")).resolves.toMatchObject({
        stage: "awaiting_ci",
        headSha: "sha-new-2",
      });
      mockGitHub.checkRunsBySha.set("sha-new-2", [
        { id: 1, name: "CI / test", status: "completed", conclusion: "success" },
      ]);
      const wake = await stub.notifyCheckSuiteCompleted({
        deliveryId: "del-cs-order",
        repository: "octo/repo",
        pullNumber: 1020,
        headSha: "sha-new-2",
        conclusion: "success",
      });
      expect(wake.woken).toBe(true);
      await expect(stub.result("del-order-new")).resolves.toMatchObject({
        status: "done",
        text: "新世代が保護されて完了",
      });
    });

    it("awaiting_ci 中に新 headSha への synchronize または PR closed が来ると旧待機を superseded で停止する", async () => {
      sandboxTestConfig.ciPollIntervalMs = 60_000;
      sandboxTestConfig.ciWaitTimeoutMs = 300_000;

      // 1. synchronize で新 headSha へ切替
      mockGitHub.headSha = "sha-sync-1";
      mockGitHub.checkRunsBySha.set("sha-sync-1", [
        { id: 1, name: "CI / test", status: "in_progress", conclusion: null },
      ]);
      const stubSync = env.ORCHESTRATOR.getByName("octo/repo#1021");
      await stubSync.start({
        ...request,
        deliveryId: "del-sync-old",
        pullNumber: 1021,
        headSha: "sha-sync-1",
      });

      mockGitHub.headSha = "sha-sync-2";
      mockGitHub.checkRunsBySha.set("sha-sync-2", [
        { id: 2, name: "CI / test", status: "completed", conclusion: "success" },
      ]);
      faux.setResponses([fauxAssistantMessage(fauxText("新 commit をレビュー"))]);
      await stubSync.start({
        ...request,
        deliveryId: "del-sync-new",
        pullNumber: 1021,
        headSha: "sha-sync-2",
        action: "synchronize",
      });
      await expect(stubSync.result("del-sync-old")).resolves.toMatchObject({
        status: "superseded",
      });
      await expect(stubSync.result("del-sync-new")).resolves.toMatchObject({
        status: "done",
        text: "新 commit をレビュー",
      });

      // 2. closed で awaiting_ci を停止
      mockGitHub.headSha = "sha-close-wait";
      mockGitHub.checkRunsBySha.set("sha-close-wait", [
        { id: 3, name: "CI / test", status: "in_progress", conclusion: null },
      ]);
      const stubClose = env.ORCHESTRATOR.getByName("octo/repo#1022");
      await stubClose.start({
        ...request,
        deliveryId: "del-close-wait",
        pullNumber: 1022,
        headSha: "sha-close-wait",
      });
      const closed = await stubClose.handlePullRequestClosed({
        deliveryId: "del-close-event",
        repository: "octo/repo",
        pullNumber: 1022,
      });
      expect(closed.cancelledCiWait).toBe(true);
      await expect(stubClose.result("del-close-wait")).resolves.toMatchObject({
        status: "superseded",
      });
    });

    it("同一 headSha に複数 deliveryId が awaiting_ci で並んでもジョブ衝突せず両方起床して完了する", async () => {
      mockGitHub.headSha = "sha-multi-wait";
      mockGitHub.checkRunsBySha.set("sha-multi-wait", [
        { id: 1, name: "CI / test", status: "in_progress", conclusion: null },
      ]);
      sandboxTestConfig.ciPollIntervalMs = 60_000;
      sandboxTestConfig.ciWaitTimeoutMs = 300_000;
      faux.setResponses([
        fauxAssistantMessage(fauxText("1件目完了")),
        fauxAssistantMessage(fauxText("2件目完了")),
      ]);

      const stub = env.ORCHESTRATOR.getByName("octo/repo#1023");
      await expect(
        stub.start({
          ...request,
          deliveryId: "del-multi-1",
          pullNumber: 1023,
          headSha: "sha-multi-wait",
        }),
      ).resolves.toMatchObject({ accepted: true, stage: "awaiting_ci" });
      await expect(
        stub.start({
          ...request,
          deliveryId: "del-multi-2",
          pullNumber: 1023,
          headSha: "sha-multi-wait",
        }),
      ).resolves.toMatchObject({ accepted: true, stage: "awaiting_ci" });

      mockGitHub.checkRunsBySha.set("sha-multi-wait", [
        { id: 1, name: "CI / test", status: "completed", conclusion: "success" },
      ]);
      await stub.notifyCheckSuiteCompleted({
        deliveryId: "del-cs-multi",
        repository: "octo/repo",
        pullNumber: 1023,
        headSha: "sha-multi-wait",
        conclusion: "success",
      });

      const [res1, res2] = await Promise.all([
        stub.result("del-multi-1"),
        stub.result("del-multi-2"),
      ]);
      expect([res1.status, res2.status]).toEqual(["done", "done"]);
    });

    it("同一 PR で full 稼働中に ci_script_hazard の新コミットへ遷移したら既存 Sandbox を即座に破棄する", async () => {
      sandboxTestConfig.hangCommand = "sleep 999";
      faux.setResponses([
        toolCall("exec", { command: "sleep 999" }),
        fauxAssistantMessage(fauxText("到達しない")),
      ]);

      const stub = env.ORCHESTRATOR.getByName("octo/repo#1024");
      await stub.start(
        withHeadSha({
          ...request,
          deliveryId: "del-full-active",
          pullNumber: 1024,
          headSha: "sha-full-1",
        }),
      );
      await vi.waitFor(() => {
        expect(executed).toContain("sleep 999");
      });
      expect(destroyedSandboxes).toHaveLength(0);

      // 次コミットで postinstall 改ざんが入り static_only へ遷移
      mockGitHub.headSha = "sha-static-2";
      mockGitHub.diff = [
        "diff --git a/package.json b/package.json",
        "--- a/package.json",
        "+++ b/package.json",
        "@@ -1,2 +1,3 @@",
        ' "scripts": {',
        '+  "postinstall": "node ./evil.js"',
        " }",
      ].join("\n");
      faux.setResponses([fauxAssistantMessage(fauxText("static_only 切替後完了"))]);

      const nextReceipt = await stub.start({
        ...request,
        deliveryId: "del-static-next",
        pullNumber: 1024,
        headSha: "sha-static-2",
        action: "synchronize",
      });
      expect(nextReceipt).toMatchObject({ executionMode: "static_only", stage: "primary_review" });
      expect(destroyedSandboxes).toHaveLength(1);
      await expect(stub.result("del-static-next")).resolves.toMatchObject({
        status: "done",
        text: "static_only 切替後完了",
      });
    });

    it("ciDiscoveryGraceMs > 0 かつ初期チェック 0 件のときはグレース待機後に CI 登録またはフォールバックへ遷移する", async () => {
      mockGitHub.headSha = "sha-grace-1";
      mockGitHub.defaultPassingCi = false;
      sandboxTestConfig.ciDiscoveryGraceMs = 40;
      sandboxTestConfig.ciPollIntervalMs = 40;
      sandboxTestConfig.ciWaitTimeoutMs = 500;
      faux.setResponses([fauxAssistantMessage(fauxText("グレース後フォールバック完了"))]);

      const stub = env.ORCHESTRATOR.getByName("octo/repo#1025");
      const receipt = await stub.start({
        ...request,
        deliveryId: "del-grace-1",
        pullNumber: 1025,
        headSha: "sha-grace-1",
      });
      expect(receipt).toMatchObject({ accepted: true, stage: "awaiting_ci" });

      // グレース期間内に CI が登録されないまま経過 -> Sandbox フォールバックでレビュー完了
      const outcome = await stub.result("del-grace-1");
      expect(outcome).toMatchObject({ status: "done", text: "グレース後フォールバック完了" });
      const state = await stub.step1Status("del-grace-1");
      expect(state?.testReport?.source).toBe("sandbox");
    });
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
