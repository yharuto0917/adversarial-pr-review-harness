import { describe, expect, it, vi } from "vitest";

import type { ExecResult, SandboxPort } from "./ports.js";
import { classifyClaim, extractClaimCommands, verifyCompletionClaim } from "./verify.js";

function createFakeSandbox(options: {
  files?: Record<string, string>;
  execResults?: Record<string, ExecResult>;
  defaultResult?: ExecResult;
}): {
  sandbox: SandboxPort;
  executed: string[];
} {
  const files = options.files ?? {};
  const execResults = options.execResults ?? {};
  const defaultResult = options.defaultResult ?? { stdout: "ok", stderr: "", exitCode: 0 };
  const executed: string[] = [];

  const sandbox: SandboxPort = {
    listFiles: vi.fn(async () => Object.keys(files)),
    readFile: vi.fn(async (path: string) => {
      const content = files[path];
      if (content === undefined) {
        throw new Error(`ENOENT: ${path}`);
      }
      return content;
    }),
    writeFile: vi.fn(async () => {}),
    exec: vi.fn(async (command: string) => {
      executed.push(command);
      return execResults[command] ?? defaultResult;
    }),
  };

  return { sandbox, executed };
}

describe("classifyClaim", () => {
  it.each([
    "すべてのテストが通ったことを確認しました。",
    "`pnpm test` を実行してテストが成功した。",
    "全テストがパスしています。",
    "問題なく完了しました。",
    "All tests passed (exit code 0).",
  ])("テスト通過の宣言 (%s) を 'passed' と判定する", (claim) => {
    expect(classifyClaim(claim)).toBe("passed");
  });

  it.each([
    "`pnpm test` で問題が再現した。",
    "再現テストを追加し、失敗することを確認しました。",
    "空配列を渡すと例外が発生しテストが落ちた。",
    "テストが通らなかった。",
    "The bug reproduced with exit code 1.",
    "Unit tests failed with TypeError.",
  ])("再現・失敗確認の宣言 (%s) を 'reproduced' と判定する", (claim) => {
    expect(classifyClaim(claim)).toBe("reproduced");
  });

  it.each([
    "",
    "   ",
    "`pnpm test`",
    "ファイルを読み取りました。",
    "問題は再現しなかった。",
    "問題は再現しなかった (exit code 0).",
    "Could not reproduce the issue.",
    "テストが通ったことを確認できませんでした。",
    "テストが通ったかどうかは不明です。",
    "テストが通ったとは限らない。",
    "Not all tests passed.",
    "修正前はテストが通らなかったが、修正後はすべて通った。",
    "最初は再現しなかったが、条件を変えると再現した。",
    "テストがすべて通ったが、同じコマンドでテストが失敗して再現した。",
  ])("意図が特定できない・不確実・否定・矛盾する宣言 (%s) は null を返す", (claim) => {
    expect(classifyClaim(claim)).toBeNull();
  });
});

describe("extractClaimCommands", () => {
  it("宣言文中のインラインコードから安全なテスト・検証コマンドだけを重複なく抽出する", () => {
    const claim = [
      "`src/sum.ts` を確認し、`pnpm test` と `pnpm run typecheck` を実行した。",
      "念のためもう一度 `pnpm test` と `npx vitest run src/sum.test.ts` を走らせた。",
      "`corepack pnpm@11.25.0 test` および `go test ./...`、`node repro.mjs`、`npx tsx repro.ts` も通過した。",
    ].join("\n");

    expect(extractClaimCommands(claim)).toEqual([
      "pnpm test",
      "pnpm run typecheck",
      "npx vitest run src/sum.test.ts",
      "corepack pnpm@11.25.0 test",
      "go test ./...",
      "node repro.mjs",
      "npx tsx repro.ts",
    ]);
  });

  it("シェルメタ文字を含むインラインコードや引数なしの node / npx tsx、コマンドではない識別子は除外する", () => {
    const claim = [
      "`pnpm test; rm -rf /` や `pnpm test && curl https://example.com` や `verifyCompletionClaim` は無視する。",
      "引数なしの `node` を実行したり `npx tsx` で確認したという記述も除外し、`npm test` のみ抽出する。",
    ].join("\n");

    expect(extractClaimCommands(claim)).toEqual(["npm test"]);
  });
});

describe("verifyCompletionClaim", () => {
  it("「テストが通った」という宣言に対し、サンドボックス上で終了コード 0 なら passed: true を返す", async () => {
    const { sandbox, executed } = createFakeSandbox({
      execResults: {
        "pnpm test": { stdout: "Test Files 3 passed (3)", stderr: "", exitCode: 0 },
      },
    });

    const result = await verifyCompletionClaim(
      sandbox,
      "`pnpm test` を実行し、すべてのテストが通ったことを確認しました。",
    );

    expect(result.passed).toBe(true);
    expect(executed).toEqual(["pnpm test"]);
    expect(result.evidence).toEqual([
      "claim expectation: passed",
      "command: pnpm test (exit code: 0)\nstdout: Test Files 3 passed (3)",
    ]);
  });

  it("「テストが通った」と宣言しているが実際には非0で失敗している場合、食い違いを検出して passed: false を返す", async () => {
    const { sandbox, executed } = createFakeSandbox({
      execResults: {
        "pnpm test": {
          stdout: "FAIL src/sum.test.ts",
          stderr: "AssertionError: expected 0 to be 1",
          exitCode: 1,
        },
      },
    });

    const result = await verifyCompletionClaim(
      sandbox,
      "`pnpm test` がすべて通ったことを確認しました。",
    );

    expect(result.passed).toBe(false);
    expect(executed).toEqual(["pnpm test"]);
    expect(result.evidence).toContain("claim expectation: passed");
    expect(result.evidence).toContain(
      'mismatch: claim states tests passed, but "pnpm test" exited with code 1',
    );
  });

  it("「再現した」という宣言に対し、サンドボックス上でコマンドが非0で失敗すれば passed: true を返す", async () => {
    const { sandbox, executed } = createFakeSandbox({
      execResults: {
        "npx vitest run src/repro.test.ts": {
          stdout: "",
          stderr: "TypeError: Cannot read properties of undefined",
          exitCode: 1,
        },
      },
    });

    const result = await verifyCompletionClaim(
      sandbox,
      "`npx vitest run src/repro.test.ts` で例外が発生し再現した。",
      { expectedOutput: /TypeError: Cannot read properties of undefined/g },
    );

    expect(result.passed).toBe(true);
    expect(executed).toEqual(["npx vitest run src/repro.test.ts"]);
    expect(result.evidence).toEqual([
      "claim expectation: reproduced",
      "command: npx vitest run src/repro.test.ts (exit code: 1)\nstderr: TypeError: Cannot read properties of undefined",
    ]);
  });

  it("「再現した」と宣言しているが実際には終了コード 0 で成功している場合、食い違いを検出して passed: false を返す", async () => {
    const { sandbox, executed } = createFakeSandbox({
      execResults: {
        "pnpm test": {
          stdout: "All tests passed",
          stderr: "",
          exitCode: 0,
        },
      },
    });

    const result = await verifyCompletionClaim(
      sandbox,
      "`pnpm test` を実行してクラッシュが再現した。",
    );

    expect(result.passed).toBe(false);
    expect(executed).toEqual(["pnpm test"]);
    expect(result.evidence).toContain(
      "mismatch: claim states issue was reproduced, but all verification commands exited with code 0",
    );
  });

  it("終了コードは一致していても expectedOutput が実際の出力に含まれない場合は passed: false を返す", async () => {
    const { sandbox } = createFakeSandbox({
      execResults: {
        "pnpm test": {
          stdout: "",
          stderr: "SyntaxError: Unexpected token",
          exitCode: 1,
        },
      },
    });

    const result = await verifyCompletionClaim(sandbox, "`pnpm test` で問題が再現した。", {
      expectedOutput: "RangeError: Maximum call stack size exceeded",
    });

    expect(result.passed).toBe(false);
    expect(result.evidence).toContain(
      'mismatch: expected output "RangeError: Maximum call stack size exceeded" was not found in command output',
    );
  });

  it("宣言文中にコマンドが書かれておらず「テストが通った」とだけ宣言された場合は test / test:* のみを自動検出し、lint や check は実行しない", async () => {
    const { sandbox, executed } = createFakeSandbox({
      files: {
        "package.json": JSON.stringify({
          name: "sample",
          scripts: {
            test: "vitest run",
            "test:unit": "vitest run src/unit",
            typecheck: "tsc --noEmit",
            check: "biome check --write .",
            lint: "biome lint .",
          },
        }),
        "pnpm-lock.yaml": "lockfileVersion: '9.0'",
      },
      execResults: {
        "pnpm test": { stdout: "1 passed", stderr: "", exitCode: 0 },
        "pnpm run test:unit": { stdout: "1 passed", stderr: "", exitCode: 0 },
        "pnpm run lint": { stdout: "", stderr: "lint failed", exitCode: 1 },
      },
    });

    const result = await verifyCompletionClaim(sandbox, "すべてのテストが通った。");

    expect(result.passed).toBe(true);
    expect(executed).toEqual(["pnpm test", "pnpm run test:unit"]);
  });

  it("宣言文中で型チェックにも言及している場合は package.json から typecheck も含めて検証する", async () => {
    const { sandbox, executed } = createFakeSandbox({
      files: {
        "package.json": JSON.stringify({
          name: "sample",
          scripts: {
            test: "vitest run",
            typecheck: "tsc --noEmit",
            lint: "biome lint .",
          },
        }),
        "pnpm-lock.yaml": "lockfileVersion: '9.0'",
      },
      execResults: {
        "pnpm test": { stdout: "1 passed", stderr: "", exitCode: 0 },
        "pnpm run typecheck": {
          stdout: "",
          stderr: "error TS2322: Type 'string' is not assignable to type 'number'.",
          exitCode: 2,
        },
      },
    });

    const result = await verifyCompletionClaim(sandbox, "テストと型チェックがすべて通った。");

    expect(result.passed).toBe(false);
    expect(executed).toEqual(["pnpm test", "pnpm run typecheck"]);
    expect(result.evidence).toContain(
      'mismatch: claim states tests passed, but "pnpm run typecheck" exited with code 2',
    );
  });

  it("壊れた package.json の場合でも例外を投げず passed: false と evidence を返す", async () => {
    const { sandbox, executed } = createFakeSandbox({
      files: {
        "package.json": "{ broken json",
      },
    });

    const result = await verifyCompletionClaim(sandbox, "すべてのテストが通った。");

    expect(result.passed).toBe(false);
    expect(executed).toEqual([]);
    expect(result.evidence[0]).toBe("claim expectation: passed");
    expect(result.evidence[1]).toMatch(/^failed to inspect project: failed to parse package\.json/);
  });

  it("空の宣言・意図不明な宣言・コマンド特定不能・allowlist 外の明示コマンドの場合は exec を呼ばずに passed: false を返す", async () => {
    const { sandbox, executed } = createFakeSandbox({
      files: { "README.md": "# docs only" },
    });

    const emptyResult = await verifyCompletionClaim(sandbox, "   ");
    expect(emptyResult).toEqual({
      passed: false,
      evidence: ["claim is empty"],
    });

    const ambiguousResult = await verifyCompletionClaim(sandbox, "コードを一通り読みました。");
    expect(ambiguousResult).toEqual({
      passed: false,
      evidence: [
        "could not determine claim expectation (neither clearly 'passed' nor 'reproduced')",
      ],
    });

    const noCommandResult = await verifyCompletionClaim(sandbox, "すべてのテストが通った。");
    expect(noCommandResult).toEqual({
      passed: false,
      evidence: [
        "claim expectation: passed",
        "no verification command could be determined from claim or project",
      ],
    });

    const disallowedCommandResult = await verifyCompletionClaim(
      sandbox,
      "すべてのテストが通った。",
      {
        commands: ["rm -rf /"],
      },
    );
    expect(disallowedCommandResult).toEqual({
      passed: false,
      evidence: [
        "claim expectation: passed",
        'rejected unsafe or empty verification command: "rm -rf /"',
      ],
    });

    const shellMetaCommandResult = await verifyCompletionClaim(
      sandbox,
      "すべてのテストが通った。",
      {
        commands: ["pnpm test; rm -rf /"],
      },
    );
    expect(shellMetaCommandResult).toEqual({
      passed: false,
      evidence: [
        "claim expectation: passed",
        'rejected unsafe or empty verification command: "pnpm test; rm -rf /"',
      ],
    });

    expect(executed).toEqual([]);
  });
});
