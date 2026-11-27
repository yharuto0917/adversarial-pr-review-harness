import { describe, expect, it } from "vitest";

import { SMELL_RULE_IDS, type SmellRuleId } from "./schema.js";
import {
  dismissedSmellSchema,
  normalizeRepoPath,
  scanDiffSmells,
  shouldSkipSmellFile,
  unquoteGitPath,
  validateSmellAccountability,
} from "./smells.js";

function makeAddedFileDiff(relPath: string, code: string): string {
  const lines = code.replace(/\n$/, "").split("\n");
  const body = lines.map((line) => `+${line}`).join("\n");
  return [
    `diff --git a/${relPath} b/${relPath}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${relPath}`,
    `@@ -0,0 +1,${lines.length} @@`,
    body,
  ].join("\n");
}

describe("scanDiffSmells: 7 種ルール positive / negative", () => {
  const cases: ReadonlyArray<{
    readonly ruleId: SmellRuleId;
    readonly file: string;
    readonly positiveCode: string;
    readonly expectedLines: readonly number[];
    readonly negativeCode: string;
  }> = [
    {
      ruleId: "STRINGIFIED_CODE_OR_EVAL",
      file: "src/themeInline.ts",
      positiveCode: [
        "export function buildScript(applyTheme: () => void): string {",
        "  return applyTheme.toString();",
        "}",
      ].join("\n"),
      expectedLines: [2],
      negativeCode: [
        "export function buildQuery(searchParams: URLSearchParams): string {",
        "  setTimeout(() => {}, 50);",
        "  return searchParams.toString();",
        "}",
      ].join("\n"),
    },
    {
      ruleId: "DUPLICATE_OR_OVERLAPPING_LISTENER",
      file: "src/embedListener.ts",
      positiveCode: [
        "export function attachEmbed(onMsg: (ev: MessageEvent) => void): void {",
        "  window.addEventListener('message', onMsg);",
        "}",
      ].join("\n"),
      expectedLines: [2],
      negativeCode: [
        "export function bindLocalClick(btn: HTMLElement, onOpen: () => void): void {",
        "  btn.addEventListener('click', onOpen);",
        "  window.removeEventListener('message', onOpen as unknown as EventListener);",
        "}",
      ].join("\n"),
    },
    {
      ruleId: "MOCK_DEFENSIVE_GUARD",
      file: "src/badgeGuard.ts",
      positiveCode: [
        "export function activateBadge(badgeEl: HTMLElement): void {",
        "  if (typeof badgeEl.classList?.add === 'function') {",
        "    badgeEl.classList.add('active');",
        "  }",
        "}",
      ].join("\n"),
      expectedLines: [2],
      negativeCode: [
        "export function activateBadgeClean(badgeEl: HTMLElement): void {",
        "  if (typeof window !== 'undefined' && typeof document.querySelector === 'function') {",
        "    badgeEl.classList.add('active');",
        "  }",
        "}",
      ].join("\n"),
    },
    {
      ruleId: "TYPE_BYPASS_OR_SILENT_FALLBACK",
      file: "src/typeBypass.ts",
      positiveCode: [
        "export function coerceAmount(input: unknown): number {",
        "  // @ts-ignore",
        "  return (input as any) + 1;",
        "}",
      ].join("\n"),
      expectedLines: [2, 3],
      negativeCode: [
        "export function coerceAmountSafe(input: unknown): number {",
        "  // @ts-expect-error intentional narrow check in caller",
        "  const narrowed = input as number;",
        "  return narrowed + 1;",
        "}",
      ].join("\n"),
    },
    {
      ruleId: "TYPE_BYPASS_OR_SILENT_FALLBACK",
      file: "src/typeBypass.py",
      positiveCode: [
        "def coerce_amount(val: object) -> int:",
        "    # type: ignore",
        "    return val + 1  # type: ignore",
      ].join("\n"),
      expectedLines: [2, 3],
      negativeCode: [
        "def coerce_amount_safe(flags: list[bool]) -> dict[str, bool]:",
        "    ok = flags[0]  # type: ignore [index]",
        "    return {'valid': any(flags), 'first': ok}",
      ].join("\n"),
    },
    {
      ruleId: "EMPTY_OR_BROAD_CATCH",
      file: "src/swallowError.py",
      positiveCode: [
        "def sync_orders() -> None:",
        "    try:",
        "        raise ValueError('bad')",
        "    except BaseException:",
        "        pass",
      ].join("\n"),
      expectedLines: [4],
      negativeCode: [
        "def sync_orders_safe() -> None:",
        "    try:",
        "        raise ValueError('bad')",
        "    except ValueError as exc:",
        "        raise RuntimeError('sync failed') from exc",
      ].join("\n"),
    },
    {
      ruleId: "DEEP_NESTING_OR_COMPLEX_FLOW",
      file: "src/complexFlow.ts",
      positiveCode: [
        "export function classifyScore(score: number, items: Array<{ id: string }>): string {",
        "                    if (score > 0) {",
        "                      void score;",
        "                    }",
        "  const map = items.reduce((acc, x) => ({ ...acc, [x.id]: true }), {});",
        "  void map;",
        "  return score > 90 ? 'gold' : score > 70 ? 'silver' : 'bronze';",
        "}",
      ].join("\n"),
      expectedLines: [2, 5, 7],
      negativeCode: [
        "type Unwrap<T> = T extends Promise<infer U> ? U extends Array<infer V> ? V : U : T;",
        "export function classifySimple(score: number, nums: number[]): string {",
        "                if (score > 0) {",
        "                  void score;",
        "                }",
        "  const total = nums.reduce((acc, n) => acc + n, 0);",
        "  return total > 90 ? 'gold' : 'standard';",
        "}",
      ].join("\n"),
    },
    {
      ruleId: "MISLEADING_OR_PASS_THROUGH",
      file: "src/misleadingGetter.ts",
      positiveCode: [
        "export async function getAccountLabel(id: string): Promise<string> {",
        "  await auditRepo.bulkCreate([{ id }]);",
        "  return id;",
        "}",
        "export function wrapFormat(v: string) { return renderText(v); }",
      ].join("\n"),
      expectedLines: [1, 5],
      negativeCode: [
        "export function isPositiveCount(count: number): boolean {",
        "  return count > 0;",
        "}",
        "export async function persistCount(count: number): Promise<void> {",
        "  await fetch('/api/counts', { method: 'POST', body: String(count) });",
        "}",
        "export function wrapFormatScaled(v: number) { return renderText(v * 100); }",
      ].join("\n"),
    },
  ];

  it("全 7 ルールをカバーしている", () => {
    const covered = new Set(cases.map((c) => c.ruleId));
    expect(covered).toEqual(new Set(SMELL_RULE_IDS));
  });

  it.each(cases)(
    "$ruleId ($file): positive を正確な行番号で検出し negative は 0 件",
    ({ ruleId, file, positiveCode, expectedLines, negativeCode }) => {
      const posDiff = makeAddedFileDiff(file, positiveCode);
      const posResult = scanDiffSmells(posDiff);
      expect(posResult.findings.map((f) => [f.ruleId, f.line])).toEqual(
        expectedLines.map((line) => [ruleId, line]),
      );
      expect(posResult.summaryByRule[ruleId]).toBe(expectedLines.length);

      // fileContents 提供時でも同一結果になる
      const withContents = scanDiffSmells(posDiff, {
        fileContents: { [`./${file}`]: positiveCode },
      });
      expect(withContents.findings.map((f) => [f.ruleId, f.line])).toEqual(
        expectedLines.map((line) => [ruleId, line]),
      );

      const negResult = scanDiffSmells(makeAddedFileDiff(file, negativeCode));
      expect(negResult.findings).toEqual([]);
    },
  );
});

describe("scanDiffSmells: エッジケースとセキュリティ・境界条件", () => {
  it("非連続ハンク跨ぎで別関数の副作用を誤検出しない", () => {
    const diff = [
      "diff --git a/src/service.ts b/src/service.ts",
      "--- a/src/service.ts",
      "+++ b/src/service.ts",
      "@@ -10,1 +10,2 @@",
      "+export async function getProfile(id: string) {",
      "   return cache.get(id);",
      "@@ -80,1 +81,2 @@",
      " export async function deleteProfile(id: string) {",
      "+  await fetch('/api/delete', { method: 'DELETE' });",
    ].join("\n");

    const result = scanDiffSmells(diff);
    expect(result.findings).toEqual([]);
  });

  it("ハンク内の ++x; 追加行（diff 行が +++x;）と CRLF と No newline 行でズレない", () => {
    const diff = [
      "diff --git a/src/counter.ts b/src/counter.ts",
      "--- a/src/counter.ts",
      "+++ b/src/counter.ts",
      "@@ -1,2 +1,4 @@",
      " export function bump(x: number, raw: unknown) {",
      "+++x;",
      "+  const v = raw as any;",
      "   return x + v;",
      "\\ No newline at end of file",
    ].join("\r\n");

    const result = scanDiffSmells(diff);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.line).toBe(3);
    expect(result.findings[0]?.ruleId).toBe("TYPE_BYPASS_OR_SILENT_FALLBACK");
  });

  it("削除のみ diff やコンテキスト行の既存スメルは検出しない", () => {
    const diff = [
      "diff --git a/src/legacy.ts b/src/legacy.ts",
      "--- a/src/legacy.ts",
      "+++ b/src/legacy.ts",
      "@@ -1,4 +1,3 @@",
      " export function keepExisting(x: unknown): number {",
      "-  const dead = 1;",
      "   try { return (x as any) + 1; } catch (e) {}",
      "   return 0;",
    ].join("\n");

    const result = scanDiffSmells(diff);
    expect(result.findings).toEqual([]);
  });

  it("Git C-quoted の日本語ファイル名をデコードして検出できる", () => {
    // "src/割引計算.py" の UTF-8 8 進エスケープ表現
    const diff = [
      'diff --git "a/src/\\345\\211\\262\\345\\274\\225\\350\\250\\210\\347\\256\\227.py" "b/src/\\345\\211\\262\\345\\274\\225\\350\\250\\210\\347\\256\\227.py"',
      "new file mode 100644",
      "--- /dev/null",
      '+++ "b/src/\\345\\211\\262\\345\\274\\225\\350\\250\\210\\347\\256\\227.py"',
      "@@ -0,0 +1,4 @@",
      "+def calc_discount(x: int) -> int:",
      "+    try:",
      "+        return x // 10",
      "+    except Exception: pass",
    ].join("\n");

    expect(
      unquoteGitPath('"b/src/\\345\\211\\262\\345\\274\\225\\350\\250\\210\\347\\256\\227.py"'),
    ).toBe("b/src/割引計算.py");

    const result = scanDiffSmells(diff);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.file).toBe("src/割引計算.py");
    expect(result.findings[0]?.ruleId).toBe("EMPTY_OR_BROAD_CATCH");
  });

  it("テスト・ロック・無視ディレクトリ・非コード拡張子をスキップし onlyFiles・maxFindings が機能する", () => {
    expect(shouldSkipSmellFile("node_modules/a/index.ts")).toBe("ignored_directory");
    expect(shouldSkipSmellFile("pnpm-lock.yaml")).toBe("generated_or_lockfile");
    expect(shouldSkipSmellFile("src/app.min.js")).toBe("generated_or_lockfile");
    expect(shouldSkipSmellFile("src/app.test.ts")).toBe("test_or_mock_file");
    expect(shouldSkipSmellFile("README.md")).toBe("non_code_extension");
    expect(shouldSkipSmellFile("src/app.ts")).toBeNull();
    expect(normalizeRepoPath("./src\\a.ts")).toBe("src/a.ts");

    const diff = [
      makeAddedFileDiff(
        "src/noisy.ts",
        "const a = x as any;\nconst b = y as any;\nconst c = z as any;",
      ),
      makeAddedFileDiff("src/app.test.ts", "const t = x as any;"),
    ].join("\n");

    const capped = scanDiffSmells(diff, { maxFindings: 2 });
    expect(capped.findings).toHaveLength(2);
    expect(capped.skippedFiles).toEqual([{ file: "src/app.test.ts", reason: "test_or_mock_file" }]);

    const zero = scanDiffSmells(diff, { maxFindings: 0 });
    expect(zero.findings).toEqual([]);
    expect(zero.summaryByRule.TYPE_BYPASS_OR_SILENT_FALLBACK).toBe(0);

    const nanCap = scanDiffSmells(diff, { maxFindings: Number.NaN });
    expect(nanCap.findings).toHaveLength(3);

    // onlyFiles: [] は対象 0 件（全件走査に反転しない）
    const emptyOnly = scanDiffSmells(diff, { onlyFiles: [] });
    expect(emptyOnly.findings).toEqual([]);
  });

  it("極端に長い単一行（8000 文字超）を安全にスキップする", () => {
    const hugeLine = `const data = "${"a".repeat(9000)}"; const x = raw as any;`;
    const result = scanDiffSmells(makeAddedFileDiff("src/data.ts", hugeLine));
    expect(result.findings).toEqual([]);
  });

  it("diff --git なしの複数ファイル unified diff とタイムスタンプ付き /dev/null を正しく分離する", () => {
    const diff = [
      "--- a/src/first.ts\t2026-11-27 00:00:00Z",
      "+++ b/src/first.ts\t2026-11-27 00:00:01Z",
      "@@ -1,1 +1,2 @@",
      " export const a = 1;",
      "+export const b = raw as any;",
      "--- a/src/deleted.ts\t2026-11-27 00:00:00Z",
      "+++ /dev/null\t2026-11-27 00:00:01Z",
      "@@ -1,1 +0,0 @@",
      "-export const gone = 1;",
      "--- a/src/second.ts\t2026-11-27 00:00:00Z",
      "+++ b/src/second.ts\t2026-11-27 00:00:01Z",
      "@@ -1,1 +1,2 @@",
      " export const c = 1;",
      "+try { run(); } catch (e) {}",
    ].join("\n");

    const result = scanDiffSmells(diff);
    expect(result.findings.map((f) => [f.file, f.line, f.ruleId])).toEqual([
      ["src/first.ts", 2, "TYPE_BYPASS_OR_SILENT_FALLBACK"],
      ["src/second.ts", 2, "EMPTY_OR_BROAD_CATCH"],
    ]);
  });

  it("引数あり自己再帰・文字列内 URL・JS 空 catch・各ルール代表分岐・fileContents 先読みを検証する", () => {
    // 引数あり自己再帰はパススルーラッパーとして誤検出しない
    const selfRecursive = "export function fib(n: number): number { return fib(n); }\n";
    expect(scanDiffSmells(makeAddedFileDiff("src/fib.ts", selfRecursive)).findings).toEqual([]);

    // 文字列リテラル内の https:// がネスト三項演算子や副作用探索を破壊しない
    const urlTernary =
      'export const endpoint = a ? "https://a.example" : b ? "https://b.example" : "https://c.example";\n';
    expect(
      scanDiffSmells(makeAddedFileDiff("src/urls.ts", urlTernary)).findings.map((f) => f.ruleId),
    ).toEqual(["DEEP_NESTING_OR_COMPLEX_FLOW"]);

    // JS/TS の複数行空 catch・.catch(() => {})・eval・タブ 5 段インデント・Python 副作用 getter
    const jsBranches = [
      "export function demo(el: HTMLElement, p: Promise<void>) {",
      "  eval('1 + 1');",
      "  el.classList?.add('on');",
      "\t\t\t\t\tif (el) { void el; }",
      "  p.catch(() => {});",
      "  try {",
      "    el.click();",
      "  } catch (err) {",
      "    // noop",
      "  }",
      "}",
    ].join("\n");
    expect(
      scanDiffSmells(makeAddedFileDiff("src/branches.ts", jsBranches)).findings.map((f) => [
        f.ruleId,
        f.line,
      ]),
    ).toEqual([
      ["STRINGIFIED_CODE_OR_EVAL", 2],
      ["MOCK_DEFENSIVE_GUARD", 3],
      ["DEEP_NESTING_OR_COMPLEX_FLOW", 4],
      ["EMPTY_OR_BROAD_CATCH", 5],
      ["EMPTY_OR_BROAD_CATCH", 8],
    ]);

    const pyGetter = [
      "def get_user_record(uid: str) -> str:",
      "    repo.save(uid)",
      "    return uid",
    ].join("\n");
    expect(
      scanDiffSmells(makeAddedFileDiff("src/py_getter.py", pyGetter)).findings.map((f) => [
        f.ruleId,
        f.line,
      ]),
    ).toEqual([["MISLEADING_OR_PASS_THROUGH", 1]]);

    // fileContents 指定時のみハンク外の関数本体（副作用）を先読みして検出できる
    const headerOnlyDiff = [
      "diff --git a/src/remote.ts b/src/remote.ts",
      "--- a/src/remote.ts",
      "+++ b/src/remote.ts",
      "@@ -1,1 +1,1 @@",
      "-export async function loadItem(id: string) {",
      "+export async function getItem(id: string) {",
    ].join("\n");
    const fullContent = [
      "export async function getItem(id: string) {",
      "  const url = 'https://api.example.com/items';",
      "  await fetch(url, { method: 'POST', body: id });",
      "  return id;",
      "}",
    ].join("\n");
    expect(scanDiffSmells(headerOnlyDiff).findings).toEqual([]);
    expect(
      scanDiffSmells(headerOnlyDiff, {
        fileContents: { "src/remote.ts": fullContent },
      }).findings.map((f) => [f.ruleId, f.line]),
    ).toEqual([["MISLEADING_OR_PASS_THROUGH", 1]]);
  });
});

describe("validateSmellAccountability", () => {
  const sampleSmells = [
    {
      file: "src/discountCalc.ts",
      line: 3,
      ruleId: "TYPE_BYPASS_OR_SILENT_FALLBACK" as const,
      tags: ["type_safety", "silent_bypass"],
      excerpt: "const raw = (amount as any) * 0.1;",
    },
    {
      file: "src/discountCalc.ts",
      line: 5,
      ruleId: "EMPTY_OR_BROAD_CATCH" as const,
      tags: ["error_handling", "swallowed_exception"],
      excerpt: "} catch (e) {}",
    },
  ];

  it("スメル 0 件のときは空 draft / 空 dismissed_smells で通過する", () => {
    const result = validateSmellAccountability([], [], []);
    expect(result).toEqual({ valid: true, unaccountedSmells: [], invalidDismissals: [] });
  });

  it("未説明スメルがあると valid=false で unaccountedSmells を返す", () => {
    const result = validateSmellAccountability(sampleSmells, [], []);
    expect(result.valid).toBe(false);
    expect(result.unaccountedSmells).toHaveLength(2);
  });

  it("同一ファイルへの draft 採用で同ファイルのスメルがカバーされる（yharuto-code-review 準拠）", () => {
    const result = validateSmellAccountability(
      sampleSmells,
      [{ path: "./src/discountCalc.ts", line: 5 }],
      [],
    );
    expect(result.valid).toBe(true);
    expect(result.unaccountedSmells).toEqual([]);
  });

  it("(ruleId, file) 単位の 10 文字以上理由付き dismissed_smells で説明できる", () => {
    const result = validateSmellAccountability(
      sampleSmells,
      [],
      [
        {
          ruleId: "TYPE_BYPASS_OR_SILENT_FALLBACK",
          file: "src/discountCalc.ts",
          reason: "外部ライブラリの誤った型定義を回避する一時キャストで単体テスト済み",
        },
        {
          ruleId: "EMPTY_OR_BROAD_CATCH",
          file: "src/discountCalc.ts",
          reason: "非同期クリーンアップ失敗は無害であり呼び出し元で再試行される設計",
        },
      ],
    );
    expect(result.valid).toBe(true);
    expect(result.unaccountedSmells).toEqual([]);
    expect(result.invalidDismissals).toEqual([]);
  });

  it("10 文字未満・空白水増し・単一文字反復の dismissed_smells を拒否する", () => {
    expect(
      dismissedSmellSchema.safeParse({
        ruleId: "EMPTY_OR_BROAD_CATCH",
        file: "src/a.ts",
        reason: "short",
      }).success,
    ).toBe(false);

    expect(
      dismissedSmellSchema.safeParse({
        ruleId: "EMPTY_OR_BROAD_CATCH",
        file: "src/a.ts",
        reason: "a          b",
      }).success,
    ).toBe(false);

    expect(
      dismissedSmellSchema.safeParse({
        ruleId: "EMPTY_OR_BROAD_CATCH",
        file: "src/a.ts",
        reason: "aaaaaaaaaaaa",
      }).success,
    ).toBe(false);

    expect(
      dismissedSmellSchema.safeParse({
        ruleId: "EMPTY_OR_BROAD_CATCH",
        file: "./",
        reason: "正規化後に空文字になるファイルパスは拒否されるべき",
      }).success,
    ).toBe(false);

    // smells が 0 件でも不正な dismissed_smells エントリがあれば invalidDismissals を報告
    const invalidWhenNoSmells = validateSmellAccountability(
      [],
      [],
      [{ ruleId: "EMPTY_OR_BROAD_CATCH", file: "src/a.ts", reason: "short" }],
    );
    expect(invalidWhenNoSmells.valid).toBe(false);
    expect(invalidWhenNoSmells.invalidDismissals).toHaveLength(1);

    // dismissed_smells[].line を明示した場合はその行のみカバーする
    const lineMismatch = validateSmellAccountability(
      sampleSmells,
      [],
      [
        {
          ruleId: "TYPE_BYPASS_OR_SILENT_FALLBACK",
          file: "src/discountCalc.ts",
          line: 99,
          reason: "別行を指定した説明では 3 行目のスメルはカバーされない",
        },
        {
          ruleId: "EMPTY_OR_BROAD_CATCH",
          file: "src/discountCalc.ts",
          line: 5,
          reason: "5 行目の空 catch は非同期後処理の無害な例外無視である",
        },
      ],
    );
    expect(lineMismatch.valid).toBe(false);
    expect(lineMismatch.unaccountedSmells).toHaveLength(1);
    expect(lineMismatch.unaccountedSmells[0]?.line).toBe(3);

    const result = validateSmellAccountability(
      sampleSmells,
      [],
      [
        {
          ruleId: "EMPTY_OR_BROAD_CATCH",
          file: "src/discountCalc.ts",
          reason: "short",
        },
      ],
    );
    expect(result.valid).toBe(false);
    expect(result.invalidDismissals).toHaveLength(1);
    expect(result.unaccountedSmells).toHaveLength(2);
  });
});
