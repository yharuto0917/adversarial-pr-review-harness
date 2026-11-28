import { testExecutionReportSchema } from "@repo/review-core";
import { describe, expect, it } from "vitest";

import type { CommitCheckItem, CommitChecksSnapshot, GitHubPort, SandboxPort } from "./ports.js";
import {
  classifyCheckKind,
  classifySandboxCommandKind,
  evaluateCommitChecksSnapshot,
  evaluateEarlyReject,
  evaluateStep1FromCi,
  runSandboxDeterministicTests,
} from "./step1.js";

function makeCheck(
  overrides: Partial<CommitCheckItem> & { readonly name: string },
): CommitCheckItem {
  return {
    source: "check_run",
    id: 1,
    appId: 10,
    appSlug: "github-actions",
    status: "completed",
    conclusion: "success",
    detailsUrl: null,
    title: null,
    summary: null,
    text: null,
    annotations: [],
    completedAt: "2026-11-28T00:00:00Z",
    ...overrides,
  };
}

function makeSnapshot(
  headSha: string,
  checks: readonly CommitCheckItem[],
  checkSuites: CommitChecksSnapshot["checkSuites"] = [],
): CommitChecksSnapshot {
  return {
    headSha,
    checks,
    checkSuites,
    truncated: false,
  };
}

describe("classifyCheckKind / classifySandboxCommandKind", () => {
  it("複合ジョブ名や requiredTestChecks を優先順位どおりに分類する", () => {
    expect(classifyCheckKind("Check, Typecheck, Test & Build")).toBe("test");
    expect(classifyCheckKind("custom-gate", ["custom-gate"])).toBe("test");
    expect(classifyCheckKind("Typecheck (tsc)")).toBe("typecheck");
    expect(classifyCheckKind("Build Workers")).toBe("build");
    expect(classifyCheckKind("Biome Lint & Format")).toBe("lint");
    expect(classifyCheckKind("Vercel Preview")).toBe("other");

    expect(classifySandboxCommandKind("pnpm test")).toBe("test");
    expect(classifySandboxCommandKind("corepack pnpm@11.25.0 run typecheck")).toBe("typecheck");
    expect(classifySandboxCommandKind("pnpm run check:ci")).toBe("lint");
    expect(classifySandboxCommandKind("go test ./...")).toBe("test");
    expect(classifySandboxCommandKind("go vet ./...")).toBe("lint");
    expect(classifySandboxCommandKind("cargo test --offline")).toBe("test");
    expect(classifySandboxCommandKind("cargo clippy --offline --all-targets")).toBe("lint");
  });
});

describe("evaluateCommitChecksSnapshot & evaluateStep1FromCi", () => {
  it("テスト系 CI が全通過なら CI 結果を証跡として採用し Sandbox 二重実行を省略する", () => {
    const evalResult = evaluateCommitChecksSnapshot({
      headSha: "head1",
      baseSha: "base1",
      headSnapshot: makeSnapshot("head1", [
        makeCheck({ name: "Check, Typecheck, Test & Build", conclusion: "success" }),
        makeCheck({ name: "Vercel Preview", status: "in_progress", conclusion: null }),
      ]),
      executionMode: "full",
      earlyRejectPolicy: "on_test_failure",
    });

    expect(evalResult.outcome).toBe("completed");
    if (evalResult.outcome === "completed") {
      expect(evalResult.skipSandboxTests).toBe(true);
      expect(evalResult.report.source).toBe("ci");
      expect(evalResult.report.overallStatus).toBe("passed");
      expect(evalResult.report.shouldEarlyReject).toBe(false);
      expect(() => testExecutionReportSchema.parse(evalResult.report)).not.toThrow();
    }
  });

  it("テスト系チェックが queued / in_progress または Check Suite 進行中なら awaiting_ci を返す", () => {
    const inProgress = evaluateCommitChecksSnapshot({
      headSha: "head1",
      headSnapshot: makeSnapshot("head1", [
        makeCheck({ name: "unit-tests", status: "in_progress", conclusion: null }),
      ]),
      executionMode: "full",
      earlyRejectPolicy: "on_test_failure",
    });
    expect(inProgress.outcome).toBe("awaiting_ci");

    const queuedSuite = evaluateCommitChecksSnapshot({
      headSha: "head1",
      headSnapshot: makeSnapshot(
        "head1",
        [],
        [{ id: 1, appId: 10, appSlug: "github-actions", status: "queued", conclusion: null }],
      ),
      executionMode: "full",
      earlyRejectPolicy: "on_test_failure",
    });
    expect(queuedSuite.outcome).toBe("awaiting_ci");

    const missingRequired = evaluateCommitChecksSnapshot({
      headSha: "head1",
      headSnapshot: makeSnapshot("head1", [makeCheck({ name: "lint", conclusion: "success" })]),
      executionMode: "full",
      earlyRejectPolicy: "on_test_failure",
      requiredTestChecks: ["ci / test"],
    });
    expect(missingRequired.outcome).toBe("awaiting_ci");
  });

  it("CI 失敗時に getCommitChecks(baseSha) と照合して failed_preexisting と変更起因 failed を分離する", async () => {
    const requestedShas: string[] = [];
    const github = {
      getCommitChecks: async (sha: string) => {
        requestedShas.push(sha);
        if (sha === "head1") {
          return makeSnapshot("head1", [
            makeCheck({ name: "flaky-legacy-test", conclusion: "failure" }),
            makeCheck({ name: "unit-test", conclusion: "failure", summary: "1 failed" }),
          ]);
        }
        return makeSnapshot("base1", [
          makeCheck({ name: "flaky-legacy-test", conclusion: "failure" }),
          makeCheck({ name: "unit-test", conclusion: "success" }),
        ]);
      },
    } as unknown as GitHubPort;

    const evalResult = await evaluateStep1FromCi(github, {
      headSha: "head1",
      baseSha: "base1",
      executionMode: "full",
      earlyRejectPolicy: "on_test_failure",
    });

    expect(requestedShas).toEqual(["head1", "base1"]);
    expect(evalResult.outcome).toBe("completed");
    if (evalResult.outcome === "completed") {
      const byName = Object.fromEntries(evalResult.report.checks.map((c) => [c.name, c.status]));
      expect(byName).toEqual({
        "flaky-legacy-test": "failed_preexisting",
        "unit-test": "failed",
      });
      expect(evalResult.report.hasRegressionFailure).toBe(true);
      expect(evalResult.report.shouldEarlyReject).toBe(true);
      expect(evalResult.report.earlyRejectReason).toContain("unit-test");
      expect(evalResult.report.earlyRejectReason).not.toContain("flaky-legacy-test");
    }
  });

  it("base でも落ちている failed_preexisting のみの場合は 3 モード全てで early_rejected にならない", async () => {
    const github = {
      getCommitChecks: async (sha: string) =>
        makeSnapshot(sha, [makeCheck({ name: "legacy-test", conclusion: "failure" })]),
    } as unknown as GitHubPort;

    for (const policy of ["on_test_failure", "never", "strict"] as const) {
      const res = await evaluateStep1FromCi(github, {
        headSha: "head1",
        baseSha: "base1",
        executionMode: "full",
        earlyRejectPolicy: policy,
      });
      expect(res.outcome).toBe("completed");
      if (res.outcome === "completed") {
        expect(res.report.overallStatus).toBe("failed_preexisting");
        expect(res.report.hasRegressionFailure).toBe(false);
        expect(res.report.shouldEarlyReject).toBe(false);
      }
    }
  });

  it("Fork PR の action_required は failed 扱いせず誤差し戻しを防ぎ、needs_sandbox_fallback に倒す", () => {
    const res = evaluateCommitChecksSnapshot({
      headSha: "head1",
      headSnapshot: makeSnapshot("head1", [
        makeCheck({ name: "CI / test", conclusion: "action_required" }),
      ]),
      executionMode: "static_only",
      staticOnlyReason: "fork_pr",
      earlyRejectPolicy: "on_test_failure",
    });

    expect(res.outcome).toBe("needs_sandbox_fallback");
    if (res.outcome === "needs_sandbox_fallback") {
      expect(res.reason).toBe("ci_action_required");
      expect(res.ciChecks[0]?.status).toBe("env_unavailable");
    }
  });

  it("getCommitChecks が権限不足（403/422）のときは ci_permission_denied でフォールバックへ委譲する", async () => {
    const permErr = Object.assign(new Error("missing checks:read"), {
      code: "GITHUB_PERMISSION_DENIED",
      status: 422,
    });
    const github = {
      getCommitChecks: async () => {
        throw permErr;
      },
    } as unknown as GitHubPort;

    const res = await evaluateStep1FromCi(github, {
      headSha: "head1",
      executionMode: "full",
      earlyRejectPolicy: "on_test_failure",
    });
    expect(res.outcome).toBe("needs_sandbox_fallback");
    if (res.outcome === "needs_sandbox_fallback") {
      expect(res.reason).toBe("ci_permission_denied");
    }
  });

  it("build が通過しても test カテゴリがすべて skipped なら passed 扱いせず all_test_ci_skipped へフォールバックする", () => {
    const res = evaluateCommitChecksSnapshot({
      headSha: "head1",
      headSnapshot: makeSnapshot("head1", [
        makeCheck({ name: "Build Workers", conclusion: "success" }),
        makeCheck({ name: "Unit Tests", conclusion: "skipped" }),
      ]),
      executionMode: "full",
      earlyRejectPolicy: "on_test_failure",
    });

    expect(res.outcome).toBe("needs_sandbox_fallback");
    if (res.outcome === "needs_sandbox_fallback") {
      expect(res.reason).toBe("all_test_ci_skipped");
    }
  });

  it("非テスト系外部アプリが check_run 登録済みの進行中 suite を持っていてもテスト CI 完了なら空待ちしない", () => {
    const res = evaluateCommitChecksSnapshot({
      headSha: "head1",
      headSnapshot: makeSnapshot(
        "head1",
        [
          makeCheck({ id: 1, appId: 10, name: "CI / test", conclusion: "success" }),
          makeCheck({
            id: 2,
            appId: 99,
            appSlug: "vercel",
            name: "Vercel Preview",
            status: "in_progress",
            conclusion: null,
          }),
        ],
        [
          {
            id: 100,
            appId: 10,
            appSlug: "github-actions",
            status: "completed",
            conclusion: "success",
          },
          { id: 200, appId: 99, appSlug: "vercel", status: "in_progress", conclusion: null },
        ],
      ),
      executionMode: "full",
      earlyRejectPolicy: "on_test_failure",
    });

    expect(res.outcome).toBe("completed");
    if (res.outcome === "completed") {
      expect(res.report.overallStatus).toBe("passed");
    }
  });

  it("CI の timed_out 完了は on_test_failure で継続、strict で early_rejected となり、staticOnlyReason 未指定でも policy で正規化される", () => {
    const onFail = evaluateCommitChecksSnapshot({
      headSha: "head1",
      headSnapshot: makeSnapshot("head1", [
        makeCheck({ name: "CI / test", conclusion: "timed_out" }),
      ]),
      executionMode: "static_only",
      earlyRejectPolicy: "on_test_failure",
    });
    expect(onFail.outcome).toBe("completed");
    if (onFail.outcome === "completed") {
      expect(onFail.report.overallStatus).toBe("timed_out");
      expect(onFail.report.shouldEarlyReject).toBe(false);
      expect(onFail.report.staticOnlyReason).toBe("policy");
    }

    const strict = evaluateCommitChecksSnapshot({
      headSha: "head1",
      headSnapshot: makeSnapshot("head1", [
        makeCheck({ name: "CI / test", conclusion: "timed_out" }),
      ]),
      executionMode: "full",
      earlyRejectPolicy: "strict",
    });
    expect(strict.outcome).toBe("completed");
    if (strict.outcome === "completed") {
      expect(strict.report.shouldEarlyReject).toBe(true);
    }
  });
});

describe("evaluateEarlyReject (3 モード)", () => {
  it("on_test_failure / never / strict の分岐をすべて仕様どおり判定する", () => {
    const testFailed = [
      {
        name: "unit-test",
        kind: "test" as const,
        source: "ci" as const,
        status: "failed" as const,
      },
    ];
    const lintOnlyFailed = [
      {
        name: "unit-test",
        kind: "test" as const,
        source: "ci" as const,
        status: "passed" as const,
      },
      {
        name: "biome-lint",
        kind: "lint" as const,
        source: "ci" as const,
        status: "failed" as const,
      },
    ];
    const testTimedOut = [
      {
        name: "unit-test",
        kind: "test" as const,
        source: "ci" as const,
        status: "timed_out" as const,
      },
    ];

    // on_test_failure: test/typecheck/build の failed のみ差し戻し、lint 単体と timed_out は継続
    expect(evaluateEarlyReject(testFailed, "on_test_failure").shouldEarlyReject).toBe(true);
    expect(evaluateEarlyReject(lintOnlyFailed, "on_test_failure").shouldEarlyReject).toBe(false);
    expect(evaluateEarlyReject(testTimedOut, "on_test_failure").shouldEarlyReject).toBe(false);

    // never: 常に継続しつつ hasRegressionFailure は正確に保持
    const neverRes = evaluateEarlyReject(testFailed, "never");
    expect(neverRes.shouldEarlyReject).toBe(false);
    expect(neverRes.hasRegressionFailure).toBe(true);

    // strict: lint 失敗・test タイムアウトでも差し戻し
    expect(evaluateEarlyReject(testFailed, "strict").shouldEarlyReject).toBe(true);
    expect(evaluateEarlyReject(lintOnlyFailed, "strict").shouldEarlyReject).toBe(true);
    expect(evaluateEarlyReject(testTimedOut, "strict").shouldEarlyReject).toBe(true);
  });
});

describe("runSandboxDeterministicTests", () => {
  it("executionMode=static_only 時は setupProject / exec を一切呼ばずに遮断レポートを返す", async () => {
    const called: string[] = [];
    const sandbox: SandboxPort = {
      exec: async (cmd) => {
        called.push(`exec:${cmd}`);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      readFile: async (path) => {
        called.push(`read:${path}`);
        return "{}";
      },
      writeFile: async () => {
        called.push("write");
      },
      listFiles: async () => {
        called.push("list");
        return ["package.json"];
      },
    };

    const result = await runSandboxDeterministicTests(sandbox, {
      headSha: "head1",
      baseSha: "base1",
      executionMode: "static_only",
      staticOnlyReason: "fork_pr",
      earlyRejectPolicy: "on_test_failure",
      fallbackReason: "ci_wait_timeout",
    });

    expect(called).toEqual([]);
    expect(result.detectedTestCommands).toEqual([]);
    expect(result.report.executionMode).toBe("static_only");
    expect(result.report.source).toBe("static_only");
    expect(result.report.overallStatus).toBe("static_only");
    expect(result.report.shouldEarlyReject).toBe(false);
    expect(() => testExecutionReportSchema.parse(result.report)).not.toThrow();
  });

  it("executionMode=full 時は依存セットアップ＋テストコマンドを決定論的実行し、失敗時に earlyRejectPolicy を適用する", async () => {
    const commands: string[] = [];
    const sandbox: SandboxPort = {
      listFiles: async () => ["package.json", "pnpm-lock.yaml"],
      readFile: async () =>
        JSON.stringify({
          name: "demo",
          scripts: { test: "vitest run", lint: "biome check ." },
        }),
      writeFile: async () => {},
      exec: async (cmd) => {
        commands.push(cmd);
        if (cmd === "pnpm test") {
          return { stdout: "", stderr: "AssertionError: expected 1 to be 2", exitCode: 1 };
        }
        return { stdout: "ok", stderr: "", exitCode: 0 };
      },
    };

    const result = await runSandboxDeterministicTests(sandbox, {
      headSha: "head1",
      baseSha: "base1",
      executionMode: "full",
      earlyRejectPolicy: "on_test_failure",
    });

    expect(commands).toEqual(["pnpm install --frozen-lockfile", "pnpm test", "pnpm run lint"]);
    expect(result.report.source).toBe("sandbox");
    expect(result.report.overallStatus).toBe("failed");
    expect(result.report.hasRegressionFailure).toBe(true);
    expect(result.report.shouldEarlyReject).toBe(true);
    expect(result.report.earlyRejectReason).toContain("pnpm test");
    expect(() => testExecutionReportSchema.parse(result.report)).not.toThrow();
  });

  it("依存セットアップが失敗した場合は project-setup (failed) を記録し、earlyRejectPolicy に従って判定する", async () => {
    const sandbox: SandboxPort = {
      listFiles: async () => ["package.json", "pnpm-lock.yaml"],
      readFile: async () => JSON.stringify({ name: "broken", scripts: { test: "vitest run" } }),
      writeFile: async () => {},
      exec: async () => ({
        stdout: "",
        stderr: "ERR_PNPM_FETCH_404 registry error",
        exitCode: 1,
      }),
    };

    const existingCiChecks = [
      {
        name: "CI / test",
        kind: "test" as const,
        source: "ci" as const,
        status: "skipped" as const,
      },
    ];

    const onFail = await runSandboxDeterministicTests(sandbox, {
      headSha: "head1",
      baseSha: "base1",
      executionMode: "full",
      earlyRejectPolicy: "on_test_failure",
      existingCiChecks,
    });
    expect(onFail.detectedTestCommands).toEqual([]);
    expect(onFail.report.source).toBe("mixed");
    expect(onFail.report.overallStatus).toBe("failed");
    expect(onFail.report.hasRegressionFailure).toBe(true);
    expect(onFail.report.shouldEarlyReject).toBe(true);
    expect(onFail.report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "project-setup",
          kind: "build",
          source: "sandbox",
          status: "failed",
        }),
      ]),
    );
    expect(() => testExecutionReportSchema.parse(onFail.report)).not.toThrow();

    const neverRes = await runSandboxDeterministicTests(sandbox, {
      headSha: "head1",
      executionMode: "full",
      earlyRejectPolicy: "never",
    });
    expect(neverRes.report.source).toBe("sandbox");
    expect(neverRes.report.overallStatus).toBe("failed");
    expect(neverRes.report.hasRegressionFailure).toBe(true);
    expect(neverRes.report.shouldEarlyReject).toBe(false);
    expect(() => testExecutionReportSchema.parse(neverRes.report)).not.toThrow();
  });

  it("依存セットアップがタイムアウトした場合は project-setup (timed_out) を記録し、strict のみ early_rejected にする", async () => {
    const sandbox: SandboxPort = {
      listFiles: async () => ["package.json", "pnpm-lock.yaml"],
      readFile: async () => JSON.stringify({ name: "slow", scripts: { test: "vitest run" } }),
      writeFile: async () => {},
      exec: async () => ({
        stdout: "",
        stderr: "command timed out after 120000ms",
        exitCode: 124,
        timedOut: true,
      }),
    };

    const onFail = await runSandboxDeterministicTests(sandbox, {
      headSha: "head1",
      executionMode: "full",
      earlyRejectPolicy: "on_test_failure",
    });
    expect(onFail.detectedTestCommands).toEqual([]);
    expect(onFail.report.overallStatus).toBe("timed_out");
    expect(onFail.report.hasRegressionFailure).toBe(false);
    expect(onFail.report.shouldEarlyReject).toBe(false);
    expect(onFail.report.checks[0]).toMatchObject({
      name: "project-setup",
      kind: "build",
      source: "sandbox",
      status: "timed_out",
    });
    expect(() => testExecutionReportSchema.parse(onFail.report)).not.toThrow();

    const strict = await runSandboxDeterministicTests(sandbox, {
      headSha: "head1",
      executionMode: "full",
      earlyRejectPolicy: "strict",
    });
    expect(strict.report.overallStatus).toBe("timed_out");
    expect(strict.report.hasRegressionFailure).toBe(false);
    expect(strict.report.shouldEarlyReject).toBe(true);
    expect(strict.report.earlyRejectReason).toContain("project-setup");
    expect(() => testExecutionReportSchema.parse(strict.report)).not.toThrow();
  });

  it("検出されたテストコマンドが 0 件の場合は project-tests (not_configured) と overallStatus=skipped を返す", async () => {
    const execCalls: string[] = [];
    const sandbox: SandboxPort = {
      listFiles: async () => ["README.md"],
      readFile: async () => "# docs only",
      writeFile: async () => {},
      exec: async (cmd) => {
        execCalls.push(cmd);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };

    const result = await runSandboxDeterministicTests(sandbox, {
      headSha: "head1",
      executionMode: "full",
      earlyRejectPolicy: "strict",
    });

    expect(execCalls).toEqual([]);
    expect(result.detectedTestCommands).toEqual([]);
    expect(result.report.source).toBe("sandbox");
    expect(result.report.overallStatus).toBe("skipped");
    expect(result.report.hasRegressionFailure).toBe(false);
    expect(result.report.shouldEarlyReject).toBe(false);
    expect(result.report.checks).toEqual([
      expect.objectContaining({
        name: "project-tests",
        kind: "test",
        source: "sandbox",
        status: "not_configured",
      }),
    ]);
    expect(() => testExecutionReportSchema.parse(result.report)).not.toThrow();
  });

  it("テストコマンド実行が timedOut を返した場合は timed_out として記録し、on_test_failure / never では継続・strict で差し戻す", async () => {
    const sandbox: SandboxPort = {
      listFiles: async () => [],
      readFile: async () => "",
      writeFile: async () => {},
      exec: async () => ({
        stdout: "",
        stderr: "test execution timed out",
        exitCode: 124,
        timedOut: true,
      }),
    };

    for (const policy of ["on_test_failure", "never", "strict"] as const) {
      const result = await runSandboxDeterministicTests(sandbox, {
        headSha: "head1",
        executionMode: "full",
        earlyRejectPolicy: policy,
        preDetectedTestCommands: ["pnpm test"],
      });
      expect(result.report.overallStatus).toBe("timed_out");
      expect(result.report.hasRegressionFailure).toBe(false);
      expect(result.report.shouldEarlyReject).toBe(policy === "strict");
      expect(result.report.checks[0]).toMatchObject({
        name: "pnpm test",
        kind: "test",
        source: "sandbox",
        status: "timed_out",
        exitCode: 124,
      });
      expect(() => testExecutionReportSchema.parse(result.report)).not.toThrow();
    }
  });

  it("preDetectedTestCommands を渡した場合は setupProject をスキップして二重初期化せず、指定コマンドのみ実行する", async () => {
    const installCalled: string[] = [];
    const execCalls: Array<{ cmd: string; timeoutMs: number | undefined }> = [];

    const installSandbox: SandboxPort = {
      listFiles: async () => {
        installCalled.push("listFiles");
        return ["package.json"];
      },
      readFile: async () => {
        installCalled.push("readFile");
        return "{}";
      },
      writeFile: async () => {
        installCalled.push("writeFile");
      },
      exec: async (cmd) => {
        installCalled.push(`exec:${cmd}`);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };

    const lockedSandbox: SandboxPort = {
      listFiles: async () => {
        installCalled.push("locked:listFiles");
        return [];
      },
      readFile: async () => {
        installCalled.push("locked:readFile");
        return "";
      },
      writeFile: async () => {},
      exec: async (cmd, opts) => {
        execCalls.push({ cmd, timeoutMs: opts?.timeoutMs });
        return { stdout: "all passed", stderr: "", exitCode: 0 };
      },
    };

    const result = await runSandboxDeterministicTests(lockedSandbox, {
      headSha: "head1",
      baseSha: "base1",
      executionMode: "full",
      earlyRejectPolicy: "on_test_failure",
      installSandbox,
      preDetectedTestCommands: ["pnpm test", "pnpm run typecheck"],
      commandTimeoutMs: 45_000,
      existingCiChecks: [
        {
          name: "CI / lint",
          kind: "lint",
          source: "ci",
          status: "skipped",
        },
      ],
    });

    expect(installCalled).toEqual([]);
    expect(execCalls).toEqual([
      { cmd: "pnpm test", timeoutMs: 45_000 },
      { cmd: "pnpm run typecheck", timeoutMs: 45_000 },
    ]);
    expect(result.detectedTestCommands).toEqual(["pnpm test", "pnpm run typecheck"]);
    expect(result.report.source).toBe("mixed");
    expect(result.report.overallStatus).toBe("passed");
    expect(result.report.hasRegressionFailure).toBe(false);
    expect(result.report.shouldEarlyReject).toBe(false);
    expect(() => testExecutionReportSchema.parse(result.report)).not.toThrow();
  });
});
