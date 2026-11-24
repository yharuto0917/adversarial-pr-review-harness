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
    const tokenRequests: Array<string | undefined> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/app/installations/42/access_tokens")) {
          tokenRequests.push(typeof init?.body === "string" ? init.body : undefined);
          const expiresAt = new Date(Date.now() + 3600_000).toISOString();
          return Response.json({ token: "ghs_inst_42", expires_at: expiresAt }, { status: 201 });
        }
        return new Response("unexpected url", { status: 404 });
      }),
    );

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

    expect(tokenRequests).toEqual([
      JSON.stringify({ repositories: ["repo"], permissions: { contents: "read" } }),
    ]);

    expect(executed).toEqual([expect.any(String), "npm install"]);
    const checkoutCmd = executed[0] ?? "";
    const expectedBasicAuth = btoa("x-access-token:ghs_inst_42");
    expect(checkoutCmd).toContain(
      "GIT_TERMINAL_PROMPT=0 git fetch --depth 1 https://github.com/octo/repo.git -- abc123",
    );
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
    await orchestrator.start({ ...request, deliveryId: "del-v1-a", headSha: "sha-v1" });
    await orchestrator.result("del-v1-a");
    expect(executed).toHaveLength(1);
    expect(destroyedSandboxes).toHaveLength(1);
    expect(readOutputs).toEqual([{ isError: false, text: "v1\n" }]);

    // 2 回目: 完了後の別 delivery → 破棄済みのため再取得され、前回の作業ファイル repro.txt は残らない
    faux.setResponses([toolCall("read_file", { path: "repro.txt" }), captureLastRead]);
    await orchestrator.start({ ...request, deliveryId: "del-v1-b", headSha: "sha-v1" });
    await orchestrator.result("del-v1-b");
    expect(executed).toHaveLength(2);
    expect(destroyedSandboxes).toHaveLength(2);
    expect(readOutputs[1]?.isError).toBe(true);
    expect(readOutputs[1]?.text).toContain("ENOENT: repro.txt");

    // 3 回目: sha-v2 に更新 → 取り直され、src/sum.ts が v2 になり、完了後に再び破棄される
    faux.setResponses([toolCall("read_file", { path: "src/sum.ts" }), captureLastRead]);
    await orchestrator.start({ ...request, deliveryId: "del-v2", headSha: "sha-v2" });
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
      await orchestrator.start({
        ...request,
        deliveryId: `del-${sha}-1`,
        pullNumber,
        headSha: sha,
      });
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
      await orchestrator.start({
        ...request,
        deliveryId: `del-${sha}-2`,
        pullNumber,
        headSha: sha,
      });
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
    await stub.start({ ...request, deliveryId: "del-ok-1", pullNumber: 910, headSha: "sha-ok" });
    await stub.result("del-ok-1");
    expect(executed).toHaveLength(2);

    // 2. sha-broken-install で依存インストールが失敗 → コンテナ即破棄＆checked_out_sha クリア
    await runInDurableObject(stub, async (instance) => {
      const orchestrator = instance as ProductionOrchestrator;
      await expect(
        orchestrator.start({
          ...request,
          deliveryId: "del-broken",
          pullNumber: 910,
          headSha: "sha-broken-install",
        }),
      ).rejects.toThrow(
        'failed to install dependencies with "pnpm install --frozen-lockfile" (exit 1): ERR_INSTALL_FAILED: registry error',
      );
    });
    expect(destroyedSandboxes).toHaveLength(2);
    expect(sandboxFiles.size).toBe(0);

    // 3. 再び sha-ok に戻した際、古い checked_out_sha が残っていないため再取得・再インストールが走る
    faux.setResponses([fauxAssistantMessage(fauxText("ok-2"))]);
    await stub.start({ ...request, deliveryId: "del-ok-2", pullNumber: 910, headSha: "sha-ok" });
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
      sql.exec("DROP TABLE review_target");
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

    await stub.start({
      ...request,
      deliveryId: "del-legacy-1",
      pullNumber: 930,
      headSha: "sha-legacy",
    });
    const result = await stub.result("del-legacy-1");

    expect(result).toMatchObject({ status: "done", text: "移行後レビュー完了" });
    expect(executed).toEqual([
      expect.stringContaining("https://github.com/octo/repo.git -- sha-legacy"),
      "pnpm install --frozen-lockfile",
    ]);
    expect(userPrompts[0]).toContain("テストコマンドの候補: pnpm test");
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

    // チェックアウト用（最小権限: repo + contents: read）と PR 操作用でトークン発行が分離され、
    // PR 操作 3 回は 2 つ目のトークンをキャッシュ再利用する（計 5 回）
    expect(githubCalls).toHaveLength(5);
    expect(githubCalls[0]).toMatchObject({
      url: "https://api.github.com/app/installations/99/access_tokens",
      method: "POST",
      body: JSON.stringify({ repositories: ["repo"], permissions: { contents: "read" } }),
    });
    expect(githubCalls[0]?.auth).toMatch(/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

    expect(githubCalls[1]).toMatchObject({
      url: "https://api.github.com/app/installations/99/access_tokens",
      method: "POST",
      body: undefined,
    });
    expect(githubCalls[1]?.auth).toMatch(/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

    expect(githubCalls.slice(2)).toEqual([
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

  it("チェックアウトがタイムアウトした場合はトークンをマスクしてタイムアウトエラーを投げ、コンテナを即破棄する", async () => {
    sandboxTestConfig.checkoutTimeoutSha = "timeout-sha";
    const stub = env.ORCHESTRATOR.getByName("octo/repo#940");
    const expectedBasicAuth = btoa("x-access-token:ghs_inst_42");

    await runInDurableObject(stub, async (instance) => {
      const orchestrator = instance as ProductionOrchestrator;
      await expect(
        orchestrator.start({
          ...request,
          deliveryId: "del-checkout-timeout",
          pullNumber: 940,
          headSha: "timeout-sha",
        }),
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
    await stub.start({
      ...request,
      deliveryId: "del-ttl-expire",
      pullNumber: 950,
      headSha: "sha-ttl",
    });

    // モデルがハング中の exec を呼ぶことを確認し、TTL 超過のアラームで自動中断・破棄されるのを待つ
    await vi.waitFor(() => {
      expect(executed).toContain("sleep 999");
    });

    const outcome = await stub.result("del-ttl-expire");
    expect(outcome.status).toBe("unanswered");
    await vi.waitFor(() => {
      expect(destroyedSandboxes).toHaveLength(1);
    });
    expect(sandboxFiles.size).toBe(0);

    // 強制破棄後に ports().sandbox が呼ばれても RUNNER へ届かず遮断される
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
    await stub.start({
      ...request,
      deliveryId: "del-recovery",
      pullNumber: 960,
      headSha: "sha-rec",
    });
    await stub.result("del-recovery");
    expect(destroyedSandboxes).toHaveLength(1);

    // DO 退避により sandbox_active=1 とクリーンアップジョブが残存した状態を再現する
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
    await stub.start({
      ...request,
      deliveryId: "del-destroy-retry",
      pullNumber: 970,
      headSha: "sha-retry",
    });

    const outcome = await stub.result("del-destroy-retry");
    expect(outcome).toMatchObject({ status: "done", text: "レビュー自体は成功" });
    // 1 回目の破棄は失敗しているためまだ destroyedSandboxes には入っていない
    expect(destroyedSandboxes).toHaveLength(0);

    // バックオフ経過後のアラームリトライで破棄が完了する
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
    await stub.start({
      ...request,
      deliveryId: "del-no-rewind",
      pullNumber: 976,
      headSha: "sha-no-rewind",
    });

    await stub.result("del-no-rewind");
    expect(destroyedSandboxes).toHaveLength(0);

    // 再度 result() を呼んでもバックオフを無視して即時 destroy() を叩かないこと
    await stub.result("del-no-rewind");
    expect(destroyedSandboxes).toHaveLength(0);

    // バックオフ経過後のアラームリトライで 1 回だけ破棄完了する
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
    await stub.start({
      ...request,
      deliveryId: "del-max-retry",
      pullNumber: 977,
      headSha: "sha-max-retry",
    });

    await stub.result("del-max-retry");
    expect(destroyedSandboxes).toHaveLength(0);

    // 最大リトライ（5 回）消化後、sandbox_active が 0 になりジョブが停止することを確認
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

    // 1. 破棄ハング時に result() がタイムアウト上限で戻り、永続リトライジョブで後から破棄完了する
    faux.setResponses([fauxAssistantMessage(fauxText("1回目完了"))]);
    const stub1 = env.ORCHESTRATOR.getByName("octo/repo#978");
    await stub1.start({
      ...request,
      deliveryId: "del-hang-retry",
      pullNumber: 978,
      headSha: "sha-hang-1",
    });

    const startedWait = Date.now();
    const res1 = await stub1.result("del-hang-retry");
    expect(res1).toMatchObject({ status: "done", text: "1回目完了" });
    // 500ms のハング完了を待たずに破棄タイムアウト (40ms) で返ること
    expect(Date.now() - startedWait).toBeLessThan(350);
    expect(destroyedSandboxes).toHaveLength(0);

    await vi.waitFor(
      () => {
        expect(destroyedSandboxes).toHaveLength(1);
      },
      { timeout: 2_000 },
    );

    // 2. 破棄がハングした直後でも同じ PR の次回 start() が無期限停止せず完了する
    sandboxTestConfig.destroyHangCount = 1;
    faux.setResponses([
      fauxAssistantMessage(fauxText("先行完了")),
      fauxAssistantMessage(fauxText("後続完了")),
    ]);
    const stub2 = env.ORCHESTRATOR.getByName("octo/repo#979");
    await stub2.start({
      ...request,
      deliveryId: "del-hang-first",
      pullNumber: 979,
      headSha: "sha-hang-a",
    });
    const firstOutcome = await stub2.result("del-hang-first");
    expect(firstOutcome).toMatchObject({ status: "done", text: "先行完了" });

    const secondStartAt = Date.now();
    await stub2.start({
      ...request,
      deliveryId: "del-hang-second",
      pullNumber: 979,
      headSha: "sha-hang-b",
    });
    const secondOutcome = await stub2.result("del-hang-second");
    expect(secondOutcome).toMatchObject({ status: "done", text: "後続完了" });
    expect(Date.now() - secondStartAt).toBeLessThan(350);
  });

  it("後片付けの事前・事後処理（ジョブ登録/解除）が例外を投げてもレビュー結果や元のセットアップエラーを失わず次回開始も成功する", async () => {
    const stub = env.ORCHESTRATOR.getByName("octo/repo#980");

    // 1. レビュー完了後のジョブ解除が一時失敗しても result() は成功結果を返し、次回 start() も通る
    faux.setResponses([
      fauxAssistantMessage(fauxText("完了結果1")),
      fauxAssistantMessage(fauxText("完了結果2")),
    ]);
    await stub.start({
      ...request,
      deliveryId: "del-cleanup-err-1",
      pullNumber: 980,
      headSha: "sha-err-1",
    });
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

    // waitUntil / result() のどちらで cancel が走ってもレビュー結果自体は正常に返る
    const res1 = await stub.result("del-cleanup-err-1");
    expect(res1).toMatchObject({ status: "done", text: "完了結果1" });

    // 次回 start() も後片付けエラーを引きずらず成功する
    await stub.start({
      ...request,
      deliveryId: "del-cleanup-err-2",
      pullNumber: 980,
      headSha: "sha-err-2",
    });
    const res2 = await stub.result("del-cleanup-err-2");
    expect(res2).toMatchObject({ status: "done", text: "完了結果2" });

    // 2. セットアップ失敗時の後片付けで事前処理（jobs.push）が例外を投げても、元のセットアップエラーを失わない
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
              // 1 回目は checkout 開始時の予約なので通し、2 回目（setup_failed 後片付けの事前処理）で失敗させる
              if (pushCalls === 2) {
                throw new Error("simulated cleanup push error");
              }
              return origJobs.push(opts);
            },
          };
        },
      });

      await expect(
        orchestrator.start({
          ...request,
          deliveryId: "del-setup-err-preserve",
          pullNumber: 981,
          headSha: "sha-setup-err-cleanup-err",
        }),
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

    // セットアップ中に TTL 超過の強制破棄（1 回目 destroy 失敗 → sandbox_active=0 で pendingDestroy 予約）が起き、
    // 直後にセットアップが失敗して setup_failed の後片付けが走っても pendingDestroy ジョブは解除されない
    await runInDurableObject(stub, async (instance) => {
      const orchestrator = instance as ProductionOrchestrator;
      await expect(
        orchestrator.start({
          ...request,
          deliveryId: "del-force-setup-race",
          pullNumber: 982,
          headSha: "sha-force-then-setup-fail",
        }),
      ).rejects.toThrow("sandbox was destroyed while preparing target");
    });

    // 1 回目は強制破棄が失敗しているため未破棄だが、pendingDestroy ジョブが生きておりリトライで破棄完了する
    expect(destroyedSandboxes).toHaveLength(0);
    await vi.waitFor(
      () => {
        expect(destroyedSandboxes).toHaveLength(1);
      },
      { timeout: 2_000 },
    );
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
