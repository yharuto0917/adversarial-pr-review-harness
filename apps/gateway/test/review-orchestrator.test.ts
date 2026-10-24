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

    expect(executed).toEqual([expect.any(String), "npm install"]);
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
  ])(
    "Node プロジェクト ($label) で依存をインストールし、テストコマンド候補をモデルに示して exec からテストを実行できる",
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
      expect(userPrompts[0]).toContain(expectedHint);
      expect(execOutputs).toEqual([
        {
          isError: false,
          text: `exit code: 0\n--- stdout ---\nPASS (${testCmd})`,
        },
      ]);

      // 同じ headSha の別 delivery では再インストールせず、テストコマンド候補の提示は維持される
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
      expect(executed).toHaveLength(3);
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

    // 2. sha-broken-install で依存インストールが失敗 → checked_out_sha はクリアされる
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

    // 3. 再び sha-ok に戻した際、古い checked_out_sha が残っていないため再取得・再インストールが走る
    faux.setResponses([fauxAssistantMessage(fauxText("ok-2"))]);
    await stub.start({ ...request, deliveryId: "del-ok-2", pullNumber: 910, headSha: "sha-ok" });
    const result = await stub.result("del-ok-2");
    expect(result).toMatchObject({ status: "done", text: "ok-2" });
    expect(executed).toHaveLength(6);
  });

  it("依存インストール中に同じ head への start() が重なった場合、実行中の Promise を共有して node_modules を壊さない", async () => {
    remoteRepoFiles.set("octo/repo@sha-concurrent", {
      "package.json": JSON.stringify({ name: "concurrent-app", scripts: { test: "vitest run" } }),
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    });

    faux.setResponses([
      toolCall("exec", { command: "pnpm test" }),
      fauxAssistantMessage(fauxText("1回目完了")),
      fauxAssistantMessage(fauxText("2回目完了")),
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

    // チェックアウトと依存インストールは 1 回ずつしか走らず、node_modules も保持されている
    const checkoutCalls = executed.filter((cmd) => cmd.includes("git init -q"));
    const installCalls = executed.filter((cmd) => cmd === "pnpm install --frozen-lockfile");
    expect(checkoutCalls).toHaveLength(1);
    expect(installCalls).toHaveLength(1);
    const [sandboxId] = [...sandboxFiles.keys()];
    expect(sandboxFiles.get(sandboxId ?? "")?.has("node_modules/.installed")).toBe(true);
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
