import { z } from "zod";

import { SMELL_RULE_IDS, type SmellRuleId, smellRuleIdSchema } from "./schema.js";

/** `scanDiffSmells` の既定最大検出件数。 */
export const DEFAULT_MAX_SMELL_FINDINGS = 50;

/** 1 行あたりの最大走査文字数。巨大な生成データ行による CPU 枯渇を防ぐ。 */
const MAX_SCANNABLE_LINE_LENGTH = 8_000;

/** `dismissed_smells[].reason` の最小文字数（空白正規化後）。 */
export const MIN_DISMISSED_SMELL_REASON_LENGTH = 10;

export const SKIPPED_SMELL_FILE_REASONS = [
  "ignored_directory",
  "generated_or_lockfile",
  "test_or_mock_file",
  "non_code_extension",
] as const;
export const skippedSmellFileReasonSchema = z.enum(SKIPPED_SMELL_FILE_REASONS);
export type SkippedSmellFileReason = z.infer<typeof skippedSmellFileReasonSchema>;

/** 検出された diff スメル 1 件。 */
export const diffSmellFindingSchema = z.object({
  file: z.string().min(1),
  line: z.number().int().positive(),
  ruleId: smellRuleIdSchema,
  tags: z.array(z.string().min(1)),
  excerpt: z.string(),
});
export type DiffSmellFinding = z.infer<typeof diffSmellFindingSchema>;

/** 走査対象外としてスキップしたファイル情報。 */
export const skippedSmellFileSchema = z.object({
  file: z.string().min(1),
  reason: skippedSmellFileReasonSchema,
});
export type SkippedSmellFile = z.infer<typeof skippedSmellFileSchema>;

export interface DiffSmellScanResult {
  readonly summaryByRule: Readonly<Record<SmellRuleId, number>>;
  readonly findings: readonly DiffSmellFinding[];
  readonly skippedFiles: readonly SkippedSmellFile[];
}

export interface ScanDiffSmellsOptions {
  /** 最大検出件数（既定: 50。`NaN`/非有限は 50、`<= 0` は 0 件を返す）。 */
  readonly maxFindings?: number | undefined;
  /**
   * 走査対象ファイルを限定する場合の相対パス一覧（再レビュー向け）。
   * `undefined` は制限なし、空配列 `[]` は対象 0 件として扱う。
   */
  readonly onlyFiles?: readonly string[] | undefined;
  /**
   * 任意のファイル全文マップ（キーはリポジトリ相対パス）。
   * 提供ファイルでは diff 追加行に対してファイル全文で複数行先読みを行い、
   * 未提供ファイルでは diff ハンク内の連続行（追加行＋コンテキスト行）のみで先読みする。
   */
  readonly fileContents?: Readonly<Record<string, string>> | undefined;
}

const IGNORED_DIRS: ReadonlySet<string> = new Set([
  ".git",
  ".gemini",
  ".claude",
  ".codex",
  ".agents",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".astro",
  "coverage",
  "target",
  "vendor",
]);

const LOCKFILE_NAMES: ReadonlySet<string> = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "bun.lock",
  "poetry.lock",
  "uv.lock",
  "Pipfile.lock",
  "Cargo.lock",
  "go.sum",
  "Gemfile.lock",
  "composer.lock",
]);

const SCANNABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".astro",
  ".vue",
  ".svelte",
  ".html",
  ".py",
  ".go",
  ".rs",
  ".rb",
  ".java",
  ".kt",
  ".php",
  ".cs",
]);

const TEMPLATE_OR_MARKUP_EXTENSIONS: ReadonlySet<string> = new Set([
  ".astro",
  ".vue",
  ".svelte",
  ".html",
]);

const TEST_FILE_RE =
  /(?:^|\/)(?:__tests__|__mocks__|tests?|specs?|fixtures?)\/|(?:\.(?:test|spec|mock)\.[A-Za-z0-9]+$)|(?:^|\/)(?:test_[^/]+\.py|[^/]+_test\.(?:py|go|rs))$/i;

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

// Rule 1: STRINGIFIED_CODE_OR_EVAL
const TO_STRING_CALL_RE = /\b([A-Za-z_$][\w$]*)\.toString\s*\(\s*\)/g;
const BENIGN_TO_STRING_CALLERS: ReadonlySet<string> = new Set([
  "err",
  "error",
  "e",
  "url",
  "uri",
  "params",
  "searchParams",
  "id",
  "count",
  "num",
  "number",
  "port",
  "date",
  "now",
  "buf",
  "buffer",
  "val",
  "value",
  "idx",
  "index",
  "status",
  "code",
]);
const EVAL_JS_RE =
  /(?:\beval\s*\(|\bnew\s+Function\s*\(|\b(?:setTimeout|setInterval)\s*\(\s*['"`]|(?:set:html|dangerouslySetInnerHTML)\s*=\s*\{[^}]*(?:<script|\.toString\s*\())/;
const EVAL_PY_RE = /(?<![.\w])(?:eval|exec)\s*\(/;

// Rule 2: DUPLICATE_OR_OVERLAPPING_LISTENER
const LISTENER_RE =
  /(?:\baddEventListener\s*\(\s*['"](?:message|storage|resize|keydown|keyup|fullscreenchange|visibilitychange|theme)['"]|\bwindow\.onmessage\s*=|\bnew\s+(?:BroadcastChannel|MutationObserver|ResizeObserver)\s*\(|\bmatchMedia\s*\([^)]*\)\.(?:addEventListener|addListener)\s*\(|\.(?:on|subscribe)\s*\(\s*['"](?:message|theme|storage|auth|sync)['"])/;

// Rule 3: MOCK_DEFENSIVE_GUARD
const MOCK_GUARD_RE =
  /(?:typeof\s+[A-Za-z_$][\w$.?]*\.(?:classList|toggle|add|remove|contains|querySelector|querySelectorAll|getElementById|setAttribute|removeAttribute|getAttribute|appendChild|removeChild|addEventListener|removeEventListener|style|dataset|focus|blur|click)\b|\b[A-Za-z_$][\w$]*\.classList\?\.(?:toggle|add|remove|contains)\s*\()/;
const SSR_GLOBAL_GUARD_RE = /typeof\s+(?:window|document|navigator|globalThis)\s*[!=]==/;

// Rule 4: TYPE_BYPASS_OR_SILENT_FALLBACK
const TYPE_BYPASS_JS_RE =
  /(?:\bas\s+any\b|:\s*any\b(?!\s*\()|@ts-ignore\b|@ts-nocheck\b|\.forEach\s*\(\s*async\b)/;
const TYPE_BYPASS_PY_RE = /#\s*type:\s*ignore\b(?!\s*\[)/;
const COMPILER_DIRECTIVE_BYPASS_RE =
  /^(?:\/\/\s*@ts-(?:ignore|nocheck)\b|#\s*type:\s*ignore\b(?!\s*\[))/;

// Rule 5: EMPTY_OR_BROAD_CATCH
const INLINE_EMPTY_CATCH_RE =
  /(?:\bcatch\s*(?:\([^)]*\))?\s*\{\s*(?:\/\/[^\n]*)?(?:\/\*.*?\*\/\s*)?\}|\.catch\s*\(\s*\([^)]*\)\s*=>\s*(?:\{\s*\}|null|undefined)\s*\))/;
const CATCH_OPEN_RE = /\bcatch\s*(?:\([^)]*\))?\s*\{\s*$/;
const PY_BROAD_EXCEPT_RE =
  /^\s*except(?:\s+(?:Exception|BaseException)(?:\s+as\s+\w+)?)?\s*:\s*(?:pass|\.\.\.)?\s*$/;

// Rule 6: DEEP_NESTING_OR_COMPLEX_FLOW
const CONTROL_FLOW_KEYWORD_RE = /^\s*(?:if|else\s+if|elif|for|while|switch|match|try)\b/;
const STRING_LITERAL_MASK_RE = /(?:'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`)/g;
const STANDALONE_TERNARY_Q_RE = /(?<!\?)\?(?![?.:])/g;
const QUADRATIC_REDUCE_RE =
  /\.reduce\s*\(\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\(?[{[]\s*\.\.\./;

// Rule 7: MISLEADING_OR_PASS_THROUGH
const PURE_NAMED_FUNC_RE =
  /(?:\b(?:async\s+)?function\s+((?:get|is|has|can|should|validate|check)[A-Z_][\w$]*)\s*\(|\bconst\s+((?:get|is|has|can|should|validate|check)[A-Z_][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>|^\s*(?:async\s+)?def\s+((?:get|is|has|can|should|validate|check)_[a-z0-9_]+)\s*\()/;
const SIDE_EFFECT_CALL_RE =
  /(?:\bfetch\s*\(|\baxios\.(?:post|put|patch|delete)\b|\.(?:insert|update|delete|save|destroy|bulkCreate)\s*\(|\b(?:localStorage|sessionStorage)\.(?:setItem|removeItem|clear)\s*\(|\b(?:UPDATE|DELETE\s+FROM|INSERT\s+INTO)\b)/;
const PASS_THROUGH_HEADER_RE =
  /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^()]*)\)/;
const PASS_THROUGH_BODY_RE = /^return\s+(?:await\s+)?([A-Za-z_$][\w$.]*)\s*\(([^()]*)\)\s*;?$/;
const IDENT_TOKEN_RE = /^[A-Za-z_$][\w$]*$/;

const C_ESCAPE_BYTES: Readonly<Record<string, number>> = {
  a: 0x07,
  b: 0x08,
  f: 0x0c,
  n: 0x0a,
  r: 0x0d,
  t: 0x09,
  v: 0x0b,
  "\\": 0x5c,
  '"': 0x22,
};

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8");

/** パス区切りを `/` に統一し、先頭の `./` のみを除去する（先頭ドットファイル名は保持）。 */
export function normalizeRepoPath(rawPath: string): string {
  let norm = rawPath.trim().replaceAll("\\", "/");
  const wasAbs = norm.startsWith("/");
  while (norm.startsWith("./")) {
    norm = norm.slice(2);
    if (!wasAbs) {
      norm = norm.replace(/^\/+/, "");
    }
  }
  return norm;
}

/** Git の C-quoted パス（`"b/src/\345..."` 等）を UTF-8 文字列へデコードする。 */
export function unquoteGitPath(raw: string): string {
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) {
    return raw;
  }
  const inner = raw.slice(1, -1);
  const bytes: number[] = [];
  let i = 0;
  while (i < inner.length) {
    const ch = inner[i];
    if (ch === "\\" && i + 1 < inner.length) {
      const next = inner[i + 1] ?? "";
      const escapedByte = C_ESCAPE_BYTES[next];
      if (escapedByte !== undefined) {
        bytes.push(escapedByte);
        i += 2;
        continue;
      }
      if (i + 3 < inner.length) {
        const octal = inner.slice(i + 1, i + 4);
        if (/^[0-7]{3}$/.test(octal)) {
          bytes.push(Number.parseInt(octal, 8) & 0xff);
          i += 4;
          continue;
        }
      }
      const nextCp = inner.codePointAt(i + 1);
      if (nextCp !== undefined) {
        const nextChar = String.fromCodePoint(nextCp);
        for (const b of utf8Encoder.encode(nextChar)) {
          bytes.push(b);
        }
        i += 1 + nextChar.length;
        continue;
      }
    }
    const cp = inner.codePointAt(i);
    if (cp === undefined) {
      break;
    }
    const char = String.fromCodePoint(cp);
    for (const b of utf8Encoder.encode(char)) {
      bytes.push(b);
    }
    i += char.length;
  }
  return utf8Decoder.decode(new Uint8Array(bytes));
}

function getFileName(posixPath: string): string {
  const slashIdx = posixPath.lastIndexOf("/");
  return slashIdx === -1 ? posixPath : posixPath.slice(slashIdx + 1);
}

function getFileExtension(posixPath: string): string {
  const name = getFileName(posixPath);
  const dotIdx = name.lastIndexOf(".");
  if (dotIdx <= 0) {
    return "";
  }
  return name.slice(dotIdx).toLowerCase();
}

/** `scan_diff_smells.py` 準拠で走査対象外ファイルかを判定する。 */
export function shouldSkipSmellFile(relPath: string): SkippedSmellFileReason | null {
  const norm = normalizeRepoPath(relPath);
  const parts = norm.split("/").filter((part) => part.length > 0);
  if (parts.some((seg) => IGNORED_DIRS.has(seg))) {
    return "ignored_directory";
  }
  const fileName = getFileName(norm);
  if (
    LOCKFILE_NAMES.has(fileName) ||
    fileName.endsWith(".min.js") ||
    fileName.endsWith(".bundle.js")
  ) {
    return "generated_or_lockfile";
  }
  if (TEST_FILE_RE.test(norm)) {
    return "test_or_mock_file";
  }
  if (!SCANNABLE_EXTENSIONS.has(getFileExtension(norm))) {
    return "non_code_extension";
  }
  return null;
}

function parseDiffPlusHeaderPath(rawLine: string): string | null {
  if (!rawLine.startsWith("+++ ")) {
    return null;
  }
  let payload = rawLine.slice(4);
  if (payload.length === 0) {
    return null;
  }

  let decoded: string;
  if (payload.startsWith('"')) {
    let endQuote = -1;
    let i = 1;
    while (i < payload.length) {
      if (payload[i] === "\\" && i + 1 < payload.length) {
        i += 2;
        continue;
      }
      if (payload[i] === '"') {
        endQuote = i;
        break;
      }
      i += 1;
    }
    if (endQuote !== -1) {
      payload = payload.slice(0, endQuote + 1);
    }
    decoded = unquoteGitPath(payload);
  } else {
    const tabIdx = payload.indexOf("\t");
    if (tabIdx !== -1) {
      payload = payload.slice(0, tabIdx);
    }
    decoded = payload;
  }

  if (decoded === "/dev/null") {
    return "/dev/null";
  }
  if (!decoded.startsWith("b/")) {
    return null;
  }
  return normalizeRepoPath(decoded.slice(2));
}

export interface ParsedDiffFile {
  readonly addedLines: Set<number>;
  /** ハンク内の右辺行（追加行 `+` とコンテキスト行 ` `）を 1-based 行番号で保持する。 */
  readonly hunkLines: Map<number, string>;
}

/** Unified diff 文字列からファイルごとの追加行番号集合およびハンク連続行マップを抽出する。 */
export function parseUnifiedDiffFiles(diffText: string): Map<string, ParsedDiffFile> {
  const files = new Map<string, ParsedDiffFile>();
  let currentFile: string | null = null;
  let inHeader = true;
  let inHunk = false;
  let oldRemaining = 0;
  let newRemaining = 0;
  let rightLine = 0;

  const getOrCreateFile = (path: string): ParsedDiffFile => {
    const existing = files.get(path);
    if (existing !== undefined) {
      return existing;
    }
    const created: ParsedDiffFile = {
      addedLines: new Set<number>(),
      hunkLines: new Map<number, string>(),
    };
    files.set(path, created);
    return created;
  };

  for (const rawLine of diffText.split(/\r?\n/)) {
    if (!inHunk && rawLine.startsWith("diff --git ")) {
      inHeader = true;
      inHunk = false;
      currentFile = null;
      oldRemaining = 0;
      newRemaining = 0;
      rightLine = 0;
      continue;
    }

    if (inHeader) {
      if (rawLine.startsWith("Binary files ") || rawLine === "GIT binary patch") {
        currentFile = null;
        inHeader = false;
        inHunk = false;
        continue;
      }
      const plusPath = parseDiffPlusHeaderPath(rawLine);
      if (plusPath !== null) {
        inHeader = false;
        currentFile = plusPath === "/dev/null" ? null : plusPath;
        rightLine = 0;
        continue;
      }
      const hunkMatch = HUNK_HEADER_RE.exec(rawLine);
      if (hunkMatch !== null) {
        inHeader = false;
        oldRemaining = hunkMatch[2] !== undefined ? Number.parseInt(hunkMatch[2], 10) : 1;
        newRemaining = hunkMatch[4] !== undefined ? Number.parseInt(hunkMatch[4], 10) : 1;
        rightLine = Number.parseInt(hunkMatch[3] ?? "0", 10);
        inHunk = oldRemaining > 0 || newRemaining > 0;
        continue;
      }
      continue;
    }

    if (!inHunk) {
      if (rawLine.startsWith("Binary files ") || rawLine === "GIT binary patch") {
        currentFile = null;
        inHeader = false;
        continue;
      }
      if (rawLine.startsWith("--- ")) {
        inHeader = true;
        currentFile = null;
        rightLine = 0;
        continue;
      }
      const plusPath = parseDiffPlusHeaderPath(rawLine);
      if (plusPath !== null) {
        inHeader = false;
        currentFile = plusPath === "/dev/null" ? null : plusPath;
        rightLine = 0;
        continue;
      }
      const hunkMatch = HUNK_HEADER_RE.exec(rawLine);
      if (hunkMatch !== null) {
        oldRemaining = hunkMatch[2] !== undefined ? Number.parseInt(hunkMatch[2], 10) : 1;
        newRemaining = hunkMatch[4] !== undefined ? Number.parseInt(hunkMatch[4], 10) : 1;
        rightLine = Number.parseInt(hunkMatch[3] ?? "0", 10);
        inHunk = oldRemaining > 0 || newRemaining > 0;
      }
      continue;
    }

    if (rawLine.startsWith("\\")) {
      // "\ No newline at end of file" は行カウンタに影響しない
      continue;
    }

    if (rawLine.startsWith("+") && newRemaining > 0) {
      if (currentFile !== null) {
        const entry = getOrCreateFile(currentFile);
        entry.addedLines.add(rightLine);
        entry.hunkLines.set(rightLine, rawLine.slice(1));
      }
      rightLine += 1;
      newRemaining -= 1;
    } else if (rawLine.startsWith("-") && oldRemaining > 0) {
      oldRemaining -= 1;
    } else if (rawLine.startsWith(" ") && oldRemaining > 0 && newRemaining > 0) {
      if (currentFile !== null) {
        const entry = getOrCreateFile(currentFile);
        entry.hunkLines.set(rightLine, rawLine.slice(1));
      }
      rightLine += 1;
      oldRemaining -= 1;
      newRemaining -= 1;
    } else if (rawLine === "" && oldRemaining > 0 && newRemaining > 0) {
      // 一部ツールが出力する空コンテキスト行（先頭空白省略）への耐性
      if (currentFile !== null) {
        const entry = getOrCreateFile(currentFile);
        entry.hunkLines.set(rightLine, "");
      }
      rightLine += 1;
      oldRemaining -= 1;
      newRemaining -= 1;
    } else {
      // ハンクが予期せず終了した場合はヘッダ／次ハンクとして再解釈する
      inHunk = false;
      if (rawLine.startsWith("diff --git ")) {
        inHeader = true;
        currentFile = null;
        oldRemaining = 0;
        newRemaining = 0;
        rightLine = 0;
      } else {
        const hunkMatch = HUNK_HEADER_RE.exec(rawLine);
        if (hunkMatch !== null) {
          oldRemaining = hunkMatch[2] !== undefined ? Number.parseInt(hunkMatch[2], 10) : 1;
          newRemaining = hunkMatch[4] !== undefined ? Number.parseInt(hunkMatch[4], 10) : 1;
          rightLine = Number.parseInt(hunkMatch[3] ?? "0", 10);
          inHunk = oldRemaining > 0 || newRemaining > 0;
        }
      }
      continue;
    }

    if (oldRemaining <= 0 && newRemaining <= 0) {
      inHunk = false;
    }
  }

  return files;
}

function leadingIndentColumns(line: string): number {
  let cols = 0;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === " ") {
      cols += 1;
    } else if (ch === "\t") {
      cols += 4 - (cols % 4);
    } else {
      break;
    }
  }
  return cols;
}

function indentationDepth(line: string): number {
  return Math.floor(leadingIndentColumns(line) / 4);
}

function isNestedTernaryLine(rawLine: string): boolean {
  if (rawLine.includes("extends ")) {
    return false;
  }
  const masked = rawLine.replace(STRING_LITERAL_MASK_RE, '""');
  const codeOnly = masked.split("//", 1)[0] ?? "";
  let questionCount = 0;
  for (const _match of codeOnly.matchAll(STANDALONE_TERNARY_Q_RE)) {
    questionCount += 1;
    if (questionCount >= 2) {
      break;
    }
  }
  if (questionCount < 2) {
    return false;
  }
  let colonCount = 0;
  for (let i = 0; i < codeOnly.length; i += 1) {
    if (codeOnly[i] === ":") {
      colonCount += 1;
      if (colonCount >= 2) {
        return true;
      }
    }
  }
  return false;
}

/** 線形時間で 1 行パススルーラッパー関数を検出する（バックトラックなし）。 */
function isPassThroughWrapperLine(rawLine: string): boolean {
  const headerMatch = PASS_THROUGH_HEADER_RE.exec(rawLine);
  if (headerMatch === null) {
    return false;
  }
  const fnName = (headerMatch[1] ?? "").trim();
  const paramsRaw = (headerMatch[2] ?? "").trim();
  const afterHeader = rawLine.slice(headerMatch[0].length);
  const openBraceIdx = afterHeader.indexOf("{");
  if (openBraceIdx === -1) {
    return false;
  }
  const returnTypePart = afterHeader.slice(0, openBraceIdx).trim();
  if (returnTypePart.length > 0 && !returnTypePart.startsWith(":")) {
    return false;
  }
  const trimmedTail = afterHeader.slice(openBraceIdx + 1).trim();
  if (!trimmedTail.endsWith("}")) {
    return false;
  }
  const body = trimmedTail.slice(0, -1).trim();
  const bodyMatch = PASS_THROUGH_BODY_RE.exec(body);
  if (bodyMatch === null) {
    return false;
  }
  const calleeName = (bodyMatch[1] ?? "").trim();
  const argsRaw = (bodyMatch[2] ?? "").trim();

  if (paramsRaw.length === 0 && argsRaw.length === 0) {
    return fnName !== calleeName;
  }
  if (paramsRaw.length === 0 || argsRaw.length === 0) {
    return false;
  }

  const paramNames: string[] = [];
  for (const rawParam of paramsRaw.split(",")) {
    let pname = (rawParam.split(":", 1)[0] ?? "").trim();
    if (pname.endsWith("?")) {
      pname = pname.slice(0, -1).trim();
    }
    if (!IDENT_TOKEN_RE.test(pname)) {
      return false;
    }
    paramNames.push(pname);
  }

  const argNames = argsRaw.split(",").map((arg) => arg.trim());
  if (paramNames.length !== argNames.length) {
    return false;
  }
  return fnName !== calleeName && paramNames.every((name, idx) => name === argNames[idx]);
}

type LineLookup = (lineNo: number) => string | undefined;

function isEmptyCatchMultiline(getLine: LineLookup, lineNo: number, isPython: boolean): boolean {
  const line = getLine(lineNo);
  if (line === undefined) {
    return false;
  }

  if (isPython) {
    if (!PY_BROAD_EXCEPT_RE.test(line)) {
      return false;
    }
    const trimmedEnd = line.trimEnd();
    if (trimmedEnd.endsWith("pass") || trimmedEnd.endsWith("...")) {
      return true;
    }
    for (let look = lineNo + 1; look < lineNo + 5; look += 1) {
      const next = getLine(look);
      if (next === undefined) {
        break;
      }
      const stripped = next.trim();
      if (stripped.length === 0 || stripped.startsWith("#")) {
        continue;
      }
      return (
        stripped === "pass" ||
        stripped === "..." ||
        stripped === "return" ||
        stripped === "return None"
      );
    }
    return false;
  }

  if (!CATCH_OPEN_RE.test(line)) {
    return false;
  }
  for (let look = lineNo + 1; look < lineNo + 5; look += 1) {
    const next = getLine(look);
    if (next === undefined) {
      break;
    }
    const stripped = next.trim();
    if (
      stripped.length === 0 ||
      stripped.startsWith("//") ||
      (stripped.startsWith("/*") && stripped.endsWith("*/"))
    ) {
      continue;
    }
    return stripped === "}";
  }
  return false;
}

function hasSideEffectInWindow(getLine: LineLookup, lineNo: number, isPython: boolean): boolean {
  const firstLine = getLine(lineNo);
  if (firstLine === undefined) {
    return false;
  }

  const collected: string[] = [];
  const endLine = lineNo + 16;

  if (isPython) {
    const baseIndent = leadingIndentColumns(firstLine);
    let inSignature = !firstLine.trimEnd().endsWith(":");
    collected.push(firstLine);

    for (let look = lineNo + 1; look < endLine; look += 1) {
      const ln = getLine(look);
      if (ln === undefined) {
        break;
      }
      const stripped = ln.trim();
      if (stripped.length === 0 || stripped.startsWith("#")) {
        continue;
      }
      if (inSignature) {
        collected.push(ln);
        if (stripped.endsWith(":")) {
          inSignature = false;
        }
        continue;
      }
      if (leadingIndentColumns(ln) <= baseIndent) {
        break;
      }
      collected.push(ln);
    }
  } else {
    let braceDepth = 0;
    let parenDepth = 0;
    let sawOpenBrace = false;

    for (let look = lineNo; look < endLine; look += 1) {
      const ln = getLine(look);
      if (ln === undefined) {
        break;
      }
      collected.push(ln);
      const maskedLine = ln.replace(STRING_LITERAL_MASK_RE, '""');
      const codePart = maskedLine.split("//", 1)[0] ?? "";
      for (let i = 0; i < codePart.length; i += 1) {
        const ch = codePart[i];
        if (ch === "(") {
          parenDepth += 1;
        } else if (ch === ")" && parenDepth > 0) {
          parenDepth -= 1;
        } else if (ch === "{" && parenDepth === 0) {
          braceDepth += 1;
          sawOpenBrace = true;
        } else if (ch === "}" && parenDepth === 0 && sawOpenBrace) {
          braceDepth -= 1;
        }
      }
      if (sawOpenBrace && braceDepth <= 0) {
        break;
      }
      if (
        !sawOpenBrace &&
        parenDepth === 0 &&
        collected.join("\n").includes("=>") &&
        codePart.trimEnd().endsWith(";")
      ) {
        break;
      }
    }
  }

  return SIDE_EFFECT_CALL_RE.test(collected.join("\n"));
}

function scanSingleFileLines(
  relFile: string,
  targetLineNumbers: readonly number[],
  getLine: LineLookup,
  maxRemaining: number,
): DiffSmellFinding[] {
  if (maxRemaining <= 0) {
    return [];
  }

  const ext = getFileExtension(relFile);
  const isPython = ext === ".py";
  const isTemplateOrMarkup = TEMPLATE_OR_MARKUP_EXTENSIONS.has(ext);
  const findings: DiffSmellFinding[] = [];

  const addFinding = (
    lineNo: number,
    ruleId: SmellRuleId,
    tags: readonly string[],
    rawLine: string,
  ): void => {
    findings.push({
      file: relFile,
      line: lineNo,
      ruleId,
      tags: [...tags],
      excerpt: rawLine.trim().slice(0, 200),
    });
  };

  for (const lineNo of targetLineNumbers) {
    if (findings.length >= maxRemaining) {
      break;
    }
    const rawLine = getLine(lineNo);
    if (rawLine === undefined || rawLine.length > MAX_SCANNABLE_LINE_LENGTH) {
      continue;
    }

    const stripped = rawLine.trim();
    if (stripped.length === 0) {
      continue;
    }

    if (stripped.startsWith("//") || stripped.startsWith("#")) {
      if (COMPILER_DIRECTIVE_BYPASS_RE.test(stripped)) {
        addFinding(
          lineNo,
          "TYPE_BYPASS_OR_SILENT_FALLBACK",
          ["type_safety", "silent_bypass"],
          rawLine,
        );
      }
      continue;
    }

    // 1. STRINGIFIED_CODE_OR_EVAL
    let matchedRule1 = false;
    for (const tsMatch of rawLine.matchAll(TO_STRING_CALL_RE)) {
      const caller = tsMatch[1] ?? "";
      if (
        !BENIGN_TO_STRING_CALLERS.has(caller) ||
        isTemplateOrMarkup ||
        rawLine.includes("<script")
      ) {
        addFinding(lineNo, "STRINGIFIED_CODE_OR_EVAL", ["ai_slop", "stringified_code"], rawLine);
        matchedRule1 = true;
        break;
      }
    }
    if (!matchedRule1) {
      if ((isPython && EVAL_PY_RE.test(rawLine)) || (!isPython && EVAL_JS_RE.test(rawLine))) {
        addFinding(lineNo, "STRINGIFIED_CODE_OR_EVAL", ["ai_slop", "dynamic_eval"], rawLine);
      }
    }
    if (findings.length >= maxRemaining) {
      break;
    }

    // 2. DUPLICATE_OR_OVERLAPPING_LISTENER
    if (LISTENER_RE.test(rawLine)) {
      addFinding(
        lineNo,
        "DUPLICATE_OR_OVERLAPPING_LISTENER",
        ["ai_slop", "listener_or_bus_overlap"],
        rawLine,
      );
      if (findings.length >= maxRemaining) {
        break;
      }
    }

    // 3. MOCK_DEFENSIVE_GUARD
    if (MOCK_GUARD_RE.test(rawLine) && !SSR_GLOBAL_GUARD_RE.test(rawLine)) {
      addFinding(
        lineNo,
        "MOCK_DEFENSIVE_GUARD",
        ["ai_slop", "mock_driven_defensive_branch"],
        rawLine,
      );
      if (findings.length >= maxRemaining) {
        break;
      }
    }

    // 4. TYPE_BYPASS_OR_SILENT_FALLBACK
    const hasTypeBypass = isPython
      ? TYPE_BYPASS_PY_RE.test(rawLine)
      : TYPE_BYPASS_JS_RE.test(rawLine) || TYPE_BYPASS_PY_RE.test(rawLine);
    if (hasTypeBypass) {
      addFinding(
        lineNo,
        "TYPE_BYPASS_OR_SILENT_FALLBACK",
        ["type_safety", "silent_bypass"],
        rawLine,
      );
      if (findings.length >= maxRemaining) {
        break;
      }
    }

    // 5. EMPTY_OR_BROAD_CATCH
    if (INLINE_EMPTY_CATCH_RE.test(rawLine) || isEmptyCatchMultiline(getLine, lineNo, isPython)) {
      addFinding(
        lineNo,
        "EMPTY_OR_BROAD_CATCH",
        ["error_handling", "swallowed_exception"],
        rawLine,
      );
      if (findings.length >= maxRemaining) {
        break;
      }
    }

    // 6. DEEP_NESTING_OR_COMPLEX_FLOW
    const isDeep = CONTROL_FLOW_KEYWORD_RE.test(rawLine) && indentationDepth(rawLine) >= 5;
    const hasNestedTernary = isNestedTernaryLine(rawLine);
    const hasQuadraticReduce = QUADRATIC_REDUCE_RE.test(rawLine);
    if (isDeep || hasNestedTernary || hasQuadraticReduce) {
      addFinding(
        lineNo,
        "DEEP_NESTING_OR_COMPLEX_FLOW",
        ["maintainability", "complex_control_flow"],
        rawLine,
      );
      if (findings.length >= maxRemaining) {
        break;
      }
    }

    // 7. MISLEADING_OR_PASS_THROUGH
    if (PURE_NAMED_FUNC_RE.test(rawLine) && hasSideEffectInWindow(getLine, lineNo, isPython)) {
      addFinding(
        lineNo,
        "MISLEADING_OR_PASS_THROUGH",
        ["naming_contract", "hidden_side_effect"],
        rawLine,
      );
    } else if (isPassThroughWrapperLine(rawLine)) {
      addFinding(lineNo, "MISLEADING_OR_PASS_THROUGH", ["ai_slop", "redundant_wrapper"], rawLine);
    }
  }

  return findings;
}

function compareCodePointOrder(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

function createEmptySummaryByRule(): Record<SmellRuleId, number> {
  return {
    STRINGIFIED_CODE_OR_EVAL: 0,
    DUPLICATE_OR_OVERLAPPING_LISTENER: 0,
    MOCK_DEFENSIVE_GUARD: 0,
    TYPE_BYPASS_OR_SILENT_FALLBACK: 0,
    EMPTY_OR_BROAD_CATCH: 0,
    DEEP_NESTING_OR_COMPLEX_FLOW: 0,
    MISLEADING_OR_PASS_THROUGH: 0,
  };
}

/**
 * Unified diff の追加・変更行から `yharuto-code-review` 準拠の 7 種スメルを走査する純粋関数。
 */
export function scanDiffSmells(
  diffText: string,
  options?: ScanDiffSmellsOptions | undefined,
): DiffSmellScanResult {
  const rawMax = options?.maxFindings;
  const maxFindings =
    rawMax === undefined || !Number.isFinite(rawMax)
      ? DEFAULT_MAX_SMELL_FINDINGS
      : Math.max(0, Math.floor(rawMax));

  const onlySet =
    options?.onlyFiles !== undefined
      ? new Set(
          options.onlyFiles.map((file) => normalizeRepoPath(file)).filter((f) => f.length > 0),
        )
      : undefined;

  const normalizedContents = new Map<string, readonly string[]>();
  if (options?.fileContents !== undefined) {
    for (const [rawKey, content] of Object.entries(options.fileContents)) {
      normalizedContents.set(normalizeRepoPath(rawKey), content.split(/\r?\n/));
    }
  }

  const parsedFiles = parseUnifiedDiffFiles(diffText);
  const sortedPaths = [...parsedFiles.keys()].sort(compareCodePointOrder);

  const skippedFiles: SkippedSmellFile[] = [];
  const allFindings: DiffSmellFinding[] = [];

  for (const relFile of sortedPaths) {
    if (onlySet !== undefined && !onlySet.has(relFile)) {
      continue;
    }
    const skipReason = shouldSkipSmellFile(relFile);
    if (skipReason !== null) {
      skippedFiles.push({ file: relFile, reason: skipReason });
      continue;
    }

    const remaining = maxFindings - allFindings.length;
    if (remaining <= 0) {
      continue;
    }

    const parsed = parsedFiles.get(relFile);
    if (parsed === undefined || parsed.addedLines.size === 0) {
      continue;
    }

    const sortedLineNumbers = [...parsed.addedLines].sort((a, b) => a - b);
    const fullLines = normalizedContents.get(relFile);
    const getLine: LineLookup =
      fullLines !== undefined
        ? (lineNo) =>
            lineNo >= 1 && lineNo <= fullLines.length ? fullLines[lineNo - 1] : undefined
        : (lineNo) => parsed.hunkLines.get(lineNo);

    const fileFindings = scanSingleFileLines(relFile, sortedLineNumbers, getLine, remaining);
    allFindings.push(...fileFindings);
  }

  const summaryByRule = createEmptySummaryByRule();
  for (const finding of allFindings) {
    if (SMELL_RULE_IDS.includes(finding.ruleId)) {
      summaryByRule[finding.ruleId] += 1;
    }
  }

  return {
    summaryByRule,
    findings: allFindings,
    skippedFiles,
  };
}

function normalizeReasonText(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

/** 検出スメルを非採用とした理由のスキーマ（空白正規化後 10 文字以上・単一文字反復禁止）。 */
export const dismissedSmellSchema = z.object({
  ruleId: smellRuleIdSchema,
  file: z
    .string()
    .trim()
    .min(1)
    .superRefine((raw, ctx) => {
      const normalized = normalizeRepoPath(raw);
      if (normalized.length === 0 || normalized === ".") {
        ctx.addIssue({
          code: "custom",
          message: `file must resolve to a valid repository-relative path, got "${raw}"`,
        });
      }
    }),
  line: z.number().int().positive().optional(),
  reason: z.string().superRefine((raw, ctx) => {
    const normalized = normalizeReasonText(raw);
    if (normalized.length < MIN_DISMISSED_SMELL_REASON_LENGTH) {
      ctx.addIssue({
        code: "custom",
        message: `reason must be at least ${MIN_DISMISSED_SMELL_REASON_LENGTH} characters after normalizing whitespace`,
      });
      return;
    }
    const nonSpaceChars = [...normalized.replace(/\s/g, "")];
    if (new Set(nonSpaceChars).size < 2) {
      ctx.addIssue({
        code: "custom",
        message: "reason must provide a concrete explanation, not a repeated single character",
      });
    }
  }),
});
export type DismissedSmell = z.infer<typeof dismissedSmellSchema>;

/** `validateSmellAccountability` が受け取るドラフト指摘の最小形状。 */
export interface SmellAccountabilityDraftRef {
  readonly path: string;
  readonly line?: number | null | undefined;
  readonly endLine?: number | null | undefined;
  readonly smellRuleId?: SmellRuleId | undefined;
}

export interface InvalidDismissedSmell {
  readonly index: number;
  readonly reason: string;
}

export interface SmellAccountabilityResult {
  readonly valid: boolean;
  readonly unaccountedSmells: readonly DiffSmellFinding[];
  readonly invalidDismissals: readonly InvalidDismissedSmell[];
}

/**
 * 検出スメル全件が `draftFindings` に採用されているか、または 10 文字以上の具体的理由付き
 * `dismissedSmells` で説明されているかを検証する（`yharuto-code-review` 準拠のファイル単位カバー）。
 */
export function validateSmellAccountability(
  smells: readonly DiffSmellFinding[],
  draftFindings: readonly SmellAccountabilityDraftRef[],
  dismissedSmells: readonly unknown[],
): SmellAccountabilityResult {
  const invalidDismissals: InvalidDismissedSmell[] = [];
  const validDismissals: Array<{
    readonly ruleId: SmellRuleId;
    readonly file: string;
    readonly line: number | undefined;
  }> = [];

  for (let i = 0; i < dismissedSmells.length; i += 1) {
    const parsed = dismissedSmellSchema.safeParse(dismissedSmells[i]);
    if (!parsed.success) {
      const firstMessage = parsed.error.issues[0]?.message ?? "invalid dismissed smell entry";
      invalidDismissals.push({ index: i, reason: firstMessage });
      continue;
    }
    validDismissals.push({
      ruleId: parsed.data.ruleId,
      file: normalizeRepoPath(parsed.data.file),
      line: parsed.data.line,
    });
  }

  if (smells.length === 0) {
    return {
      valid: invalidDismissals.length === 0,
      unaccountedSmells: [],
      invalidDismissals,
    };
  }

  const draftFiles = new Set<string>();
  for (const draft of draftFindings) {
    const normalizedPath = normalizeRepoPath(draft.path);
    if (normalizedPath.length > 0) {
      draftFiles.add(normalizedPath);
    }
  }

  const unaccountedSmells: DiffSmellFinding[] = [];
  for (const smell of smells) {
    const normalizedSmellFile = normalizeRepoPath(smell.file);
    const coveredByDraft = draftFiles.has(normalizedSmellFile);
    const coveredByDismissal = validDismissals.some(
      (dismissed) =>
        dismissed.ruleId === smell.ruleId &&
        dismissed.file === normalizedSmellFile &&
        (dismissed.line === undefined || dismissed.line === smell.line),
    );
    if (!coveredByDraft && !coveredByDismissal) {
      unaccountedSmells.push(smell);
    }
  }

  return {
    valid: unaccountedSmells.length === 0 && invalidDismissals.length === 0,
    unaccountedSmells,
    invalidDismissals,
  };
}
