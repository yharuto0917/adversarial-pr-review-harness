import { DEFAULT_REPO_REVIEW_CONFIG } from "@repo/review-core";
import { describe, expect, it } from "vitest";

import type { GitHubPort, PullRequestMeta } from "./ports.js";
import { loadRepoReviewConfig, runStep0Preprocessing } from "./step0.js";

function createFakeGitHub(overrides: Partial<GitHubPort> = {}): GitHubPort {
  const defaultMeta: PullRequestMeta = {
    number: 10,
    state: "open",
    draft: false,
    title: "Normal PR",
    body: null,
    authorLogin: "alice",
    baseSha: "base111",
    headSha: "head222",
    baseRef: "main",
    headRef: "feat/a",
    defaultBranch: "main",
    baseRepoId: 100,
    headRepoId: 100,
    baseRepoFullName: "octo/repo",
    headRepoFullName: "octo/repo",
    isFork: false,
  };

  return {
    getPullRequestMeta: async () => defaultMeta,
    getDiff: async () =>
      [
        "diff --git a/src/a.ts b/src/a.ts",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -1,1 +1,2 @@",
        " export const x = 1;",
        "+export const y = 2;",
      ].join("\n"),
    listPullRequestFiles: async () => ({ files: [], truncated: false }),
    getCommitChecks: async (headSha) => ({
      headSha,
      checks: [],
      checkSuites: [],
      truncated: false,
    }),
    listReviewThreads: async () => ({ threads: [], truncated: false }),
    getFileContent: async () => null,
    ...overrides,
  };
}

describe("loadRepoReviewConfig", () => {
  it("必ず defaultBranch から宣言設定を読み取り、PR head 側を無視して管理ストア上限へクランプする", async () => {
    const requestedRefs: Array<{ path: string; ref: string }> = [];
    const github = createFakeGitHub({
      getFileContent: async (path, ref) => {
        requestedRefs.push({ path, ref });
        if (path === ".github/review-harness.json" && ref === "main") {
          return JSON.stringify({
            earlyRejectPolicy: "strict",
            budgetUsd: 999,
            maxConcurrentVerifiers: 5,
            mainModel: "openai/evil-model",
            requiredTestChecks: ["CI / test"],
          });
        }
        if (path === "REVIEW.md" && ref === "main") {
          return "# 規約\n境界値テストを書くこと。";
        }
        return null;
      },
    });

    const loaded = await loadRepoReviewConfig(github, {
      defaultBranch: "main",
      baseRef: "feature/unprotected",
      baseSha: "unprotected-sha",
      managedConfig: { ...DEFAULT_REPO_REVIEW_CONFIG, budgetUsd: 5, maxConcurrentVerifiers: 2 },
      adminPolicy: { allowRepoModelOverride: false },
    });

    // 非デフォルト base ブランチ（feature/unprotected）ではなく defaultBranch ("main") のみ参照すること
    expect(requestedRefs).toEqual([
      { path: ".github/review-harness.json", ref: "main" },
      { path: "REVIEW.md", ref: "main" },
    ]);
    expect(loaded.configPath).toBe(".github/review-harness.json");
    expect(loaded.config.earlyRejectPolicy).toBe("strict");
    expect(loaded.config.budgetUsd).toBe(5);
    expect(loaded.config.maxConcurrentVerifiers).toBe(2);
    expect(loaded.config.mainModel).toBe(DEFAULT_REPO_REVIEW_CONFIG.mainModel);
    expect(loaded.config.requiredTestChecks).toEqual(["CI / test"]);
    expect(loaded.clampedFields.map((f) => f.field)).toEqual(
      expect.arrayContaining(["budgetUsd", "maxConcurrentVerifiers", "mainModel"]),
    );
    expect(loaded.reviewGuidelines).toBe("# 規約\n境界値テストを書くこと。");
  });

  it("宣言設定の JSON が壊れている場合は警告を記録して管理ストア設定へ安全フォールバックする", async () => {
    const github = createFakeGitHub({
      getFileContent: async (path, ref) => {
        if (path === ".review-harness.json" && ref === "main") {
          return "{ invalid json";
        }
        return null;
      },
    });

    const loaded = await loadRepoReviewConfig(github, {
      defaultBranch: "main",
      managedConfig: DEFAULT_REPO_REVIEW_CONFIG,
    });

    expect(loaded.configParseError).toBe(true);
    expect(loaded.config).toEqual(DEFAULT_REPO_REVIEW_CONFIG);
    expect(loaded.warnings.some((w) => w.includes("failed to parse .review-harness.json"))).toBe(
      true,
    );
  });

  it("設定ファイルが symlink やサイズ超過等で GITHUB_INVALID_RESPONSE になっても警告付きで安全フォールバックする", async () => {
    const invalidErr = Object.assign(new Error("unsupported content type: symlink"), {
      code: "GITHUB_INVALID_RESPONSE",
      status: 200,
    });
    const github = createFakeGitHub({
      getFileContent: async (path, ref) => {
        if (path === ".github/review-harness.json" && ref === "main") {
          throw invalidErr;
        }
        if (path === ".review-harness.json" && ref === "main") {
          return JSON.stringify({ earlyRejectPolicy: "never" });
        }
        return null;
      },
    });

    const loaded = await loadRepoReviewConfig(github, {
      defaultBranch: "main",
      managedConfig: DEFAULT_REPO_REVIEW_CONFIG,
    });

    expect(loaded.configPath).toBe(".review-harness.json");
    expect(loaded.config.earlyRejectPolicy).toBe("never");
    expect(loaded.warnings.some((w) => w.includes("ignored invalid config entry"))).toBe(true);
  });
});

describe("runStep0Preprocessing", () => {
  it("meta.headSha が request.headSha と一致しない場合は TOCTOU 防止のため stale を返す", async () => {
    const github = createFakeGitHub();
    const res = await runStep0Preprocessing(github, {
      headSha: "old-sha-before-force-push",
      managedConfig: DEFAULT_REPO_REVIEW_CONFIG,
    });

    expect(res.status).toBe("stale");
    if (res.status === "stale") {
      expect(res.latestHeadSha).toBe("head222");
    }
  });

  it("外部フォーク PR は executionMode=static_only (fork_pr) を強制する", async () => {
    const github = createFakeGitHub({
      getPullRequestMeta: async () => ({
        number: 10,
        state: "open",
        draft: false,
        title: "Fork PR",
        body: null,
        authorLogin: "eve",
        baseSha: "base111",
        headSha: "head222",
        baseRef: "main",
        headRef: "patch-1",
        defaultBranch: "main",
        baseRepoId: 100,
        headRepoId: 200,
        baseRepoFullName: "octo/repo",
        headRepoFullName: "eve/repo",
        isFork: true,
      }),
    });

    const res = await runStep0Preprocessing(github, {
      headSha: "head222",
      webhookIsFork: false,
      managedConfig: DEFAULT_REPO_REVIEW_CONFIG,
    });

    expect(res.status).toBe("ready");
    if (res.status === "ready") {
      expect(res.isFork).toBe(true);
      expect(res.executionMode).toBe("static_only");
      expect(res.staticOnlyReason).toBe("fork_pr");
    }
  });

  it("内部 PR でも ci_script_hazard 検出時は executionMode=static_only (ci_script_hazard) を強制する", async () => {
    const diffRanges: unknown[] = [];
    const github = createFakeGitHub({
      getDiff: async (range) => {
        diffRanges.push(range);
        return [
          "diff --git a/package.json b/package.json",
          "--- a/package.json",
          "+++ b/package.json",
          "@@ -1,2 +1,3 @@",
          ' "scripts": {',
          '+  "postinstall": "node evil.js"',
          " }",
        ].join("\n");
      },
    });

    const res = await runStep0Preprocessing(github, {
      headSha: "head222",
      managedConfig: DEFAULT_REPO_REVIEW_CONFIG,
    });

    expect(diffRanges).toEqual([{ base: "base111", head: "head222" }]);
    expect(res.status).toBe("ready");
    if (res.status === "ready") {
      expect(res.isFork).toBe(false);
      expect(res.executionMode).toBe("static_only");
      expect(res.staticOnlyReason).toBe("ci_script_hazard");
      expect(res.ciScriptHazard.detected).toBe(true);
    }
  });

  it("getDiff が 406 (diff too large) の場合は listPullRequestFiles へフォールバックし、truncated なら fail-closed で static_only にする", async () => {
    const err = Object.assign(new Error("diff too large"), {
      code: "GITHUB_DIFF_TOO_LARGE",
      status: 406,
    });
    const github = createFakeGitHub({
      getDiff: async () => {
        throw err;
      },
      listPullRequestFiles: async () => ({
        files: [
          { filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1 },
        ],
        truncated: true,
      }),
    });

    const res = await runStep0Preprocessing(github, {
      headSha: "head222",
      managedConfig: DEFAULT_REPO_REVIEW_CONFIG,
    });

    expect(res.status).toBe("ready");
    if (res.status === "ready") {
      expect(res.diffTooLarge).toBe(true);
      expect(res.executionMode).toBe("static_only");
      expect(res.staticOnlyReason).toBe("ci_script_hazard");
    }
  });

  it("406 フォールバックの listPullRequestFiles 取得中に force-push された場合は TOCTOU を検知して stale を返す", async () => {
    const err = Object.assign(new Error("diff too large"), {
      code: "GITHUB_DIFF_TOO_LARGE",
      status: 406,
    });
    let metaCalls = 0;
    const github = createFakeGitHub({
      getPullRequestMeta: async () => {
        metaCalls += 1;
        return {
          number: 10,
          state: "open",
          draft: false,
          title: "Race PR",
          body: null,
          authorLogin: "alice",
          baseSha: "base111",
          headSha: metaCalls === 1 ? "head222" : "head-pushed-during-files",
          baseRef: "main",
          headRef: "feat/a",
          defaultBranch: "main",
          baseRepoId: 100,
          headRepoId: 100,
          baseRepoFullName: "octo/repo",
          headRepoFullName: "octo/repo",
          isFork: false,
        };
      },
      getDiff: async () => {
        throw err;
      },
      listPullRequestFiles: async () => ({
        files: [
          { filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1 },
        ],
        truncated: false,
      }),
    });

    const res = await runStep0Preprocessing(github, {
      headSha: "head222",
      managedConfig: DEFAULT_REPO_REVIEW_CONFIG,
    });

    expect(metaCalls).toBe(2);
    expect(res.status).toBe("stale");
    if (res.status === "stale") {
      expect(res.latestHeadSha).toBe("head-pushed-during-files");
    }
  });
});
