import type { PullRequestFileEntry } from "./ports.js";

export interface CiScriptHazardResult {
  readonly detected: boolean;
  readonly reasons: readonly string[];
}

/**
 * 任意のディレクトリ配下で変更・追加・リネーム・バイナリ化が行われた時点で
 * 無条件に `ci_script_hazard` とみなすビルド／ツールチェーン／テストランナー設定ファイル。
 */
const UNCONDITIONAL_HAZARD_BASENAMES: ReadonlySet<string> = new Set([
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  ".pnpmfile.cjs",
  ".pnpmfile.mjs",
  "pnpmfile.cjs",
  "pnpm-workspace.yaml",
  "setup.py",
  "setup.cfg",
  "sitecustomize.py",
  "usercustomize.py",
  "build.rs",
  "conftest.py",
  ".gitattributes",
  "Makefile",
  "GNUmakefile",
  "makefile",
  "justfile",
  "Taskfile.yml",
  "Taskfile.yaml",
]);

const UNCONDITIONAL_HAZARD_SUFFIXES: readonly string[] = ["/.cargo/config", "/.cargo/config.toml"];

const UNCONDITIONAL_HAZARD_DIR_SEGMENT_RE = /(?:^|\/)(?:\.venv|venv)\//i;
const TEST_RUNNER_CONFIG_RE = /^(?:(?:vitest|jest|playwright)\.(?:config|workspace)\.[cm]?[jt]s)$/i;

/** `package.json` 内でインストール・テスト・ビルド時に自動実行されうるフック／設定キー。 */
const PACKAGE_JSON_LIFECYCLE_KEY_RE =
  /"(?:(?:pre|post)[A-Za-z0-9_.:-]+|install|prepare|packageManager|pnpm)"\s*:/;

/** `package.json` 内で直接スクリプト実行や外部 URL 依存を持ち込む記述。 */
const PACKAGE_JSON_EXEC_OR_URL_RE =
  /(?:(?:"(?:test|test:[A-Za-z0-9_.:-]+|lint|check|check:ci|typecheck|type-check|build)"\s*:\s*"[^"]*(?:\b(?:node|sh|bash|zsh|dash|ksh|python3?|tsx|ts-node)\s))|:\s*"(?:file:|git\+|https?:\/\/|github:))/i;

/** `pyproject.toml` 内でビルド実行・カスタムインデックス・pytest 引数注入を伴う設定。 */
const PYPROJECT_EXEC_OR_INDEX_RE =
  /(?:\b(?:build-backend|backend-path|index-url|extra-index-url|find-links|addopts)\s*=|^\s*\[build-system\])/i;

/** `Cargo.toml` 内でコンパイル時にコード実行を伴う設定変更（ハイフン・アンダースコア両対応）。 */
const CARGO_TOML_EXEC_HOOK_RE = /\b(?:build\s*=|proc[-_]macro\s*=\s*true)\b/;

/** `yharuto-code-review` 準拠の危険コマンド・外部送信・フック注入パターン。 */
const CI_SCRIPT_HAZARD_RE =
  /(?:\bnode\b[^\n]*(?:[\s"']-(?:e\b|-eval\b)|--input-type\b)|\bpython3?\b[^\n]*[\s"']-c\b|\b(?:sh|bash|zsh|dash|ksh)\b[^\n]*[\s"']-c\b|\b(?:curl|wget|nc|ncat|netcat|socat)\s|\beval\s*(?:\(|["'`$])|\b(?:writeFileSync|appendFileSync|child_process|execSync|spawnSync|execFileSync)\b|\b(?:os\.system|subprocess\.(?:Popen|run|call|check_output|check_call)|urllib\.request|http\.client|socket\.connect)\b|(?:^|\n)\s*(?:script-shell|onload-script|node-options|rustc-wrapper|rustc-workspace-wrapper|runner)\s*=|\b(?:RUSTC_WRAPPER|LD_PRELOAD|DYLD_INSERT_LIBRARIES)\b|(?:\/dev\/tcp\/|base64\s+-d|\|\s*(?:sh|bash)\b))/;

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
// 引用符付きパス（diff --git "a/foo bar" "b/foo bar"）と通常パスの両方に対応
const DIFF_GIT_HEADER_RE =
  /^diff --git (?:"a\/((?:[^"\\]|\\.)+)"|a\/(\S+)) (?:"b\/((?:[^"\\]|\\.)+)"|b\/(\S+))$/;
const BINARY_FILES_RE =
  /^Binary files (?:"a\/((?:[^"\\]|\\.)+)"|a\/(\S+)|\/dev\/null) and (?:"b\/((?:[^"\\]|\\.)+)"|b\/(\S+)|\/dev\/null) differ$/;

type FileRiskCategory = "unconditional" | "package_json" | "cargo_toml" | "pyproject_toml" | "none";

/**
 * unified diff（PR 全体差分）を解析し、外部コード実行・依存フック改ざん等の
 * `ci_script_hazard` を決定論的に検出する。
 *
 * hunk 行数（`@@ -a,b +c,d @@`）を追跡することで、他ファイルの追加行に偽装された
 * `diff --git` / `+++ b/...` によるパーサ脱同期を防ぐ。
 */
export function detectCiScriptHazardInDiff(diffText: string): CiScriptHazardResult {
  const reasons: string[] = [];
  const addReason = (reason: string) => {
    if (!reasons.includes(reason)) {
      reasons.push(reason);
    }
  };

  let currentFile = "";
  let currentCategory: FileRiskCategory = "none";
  let oldRemaining = 0;
  let newRemaining = 0;

  for (const rawLine of diffText.split(/\r?\n/)) {
    const inHunk = oldRemaining > 0 || newRemaining > 0;

    if (inHunk) {
      if (rawLine.startsWith("\\ No newline at end of file")) {
        continue;
      }
      if (rawLine.startsWith("+")) {
        newRemaining -= 1;
        inspectAddedLine(currentFile, currentCategory, rawLine.slice(1), addReason);
        continue;
      }
      if (rawLine.startsWith("-")) {
        oldRemaining -= 1;
        continue;
      }
      if (rawLine.startsWith(" ")) {
        oldRemaining -= 1;
        newRemaining -= 1;
        continue;
      }
      if (rawLine.length === 0) {
        oldRemaining = Math.max(0, oldRemaining - 1);
        newRemaining = Math.max(0, newRemaining - 1);
        continue;
      }
      oldRemaining = 0;
      newRemaining = 0;
    }

    const diffGitMatch = DIFF_GIT_HEADER_RE.exec(rawLine);
    if (diffGitMatch !== null) {
      const pathA = normalizeDiffPath(diffGitMatch[1] ?? diffGitMatch[2] ?? "");
      const pathB = normalizeDiffPath(diffGitMatch[3] ?? diffGitMatch[4] ?? "");
      currentFile = pathB || pathA;
      currentCategory = classifyFilePathRisk(currentFile);
      if (currentCategory === "unconditional") {
        addReason(`${currentFile}: sensitive build/toolchain configuration file modified`);
      } else if (pathA.length > 0 && classifyFilePathRisk(pathA) === "unconditional") {
        addReason(`${pathA}: sensitive build/toolchain configuration file modified`);
      }
      continue;
    }

    if (rawLine.startsWith("rename from ") || rawLine.startsWith("rename to ")) {
      const renamedPath = normalizeDiffPath(
        rawLine.startsWith("rename from ")
          ? rawLine.slice("rename from ".length)
          : rawLine.slice("rename to ".length),
      );
      if (renamedPath.length > 0) {
        const category = classifyFilePathRisk(renamedPath);
        if (category === "unconditional") {
          addReason(`${renamedPath}: sensitive build/toolchain configuration file renamed`);
        }
        if (rawLine.startsWith("rename to ")) {
          currentFile = renamedPath;
          currentCategory = category;
        }
      }
      continue;
    }

    if (rawLine.startsWith("+++ ")) {
      const plusPath = parseDiffHeaderPath(rawLine, "+++ ");
      if (plusPath === null || plusPath === "/dev/null") {
        currentFile = "";
        currentCategory = "none";
      } else {
        currentFile = plusPath;
        currentCategory = classifyFilePathRisk(currentFile);
        if (currentCategory === "unconditional") {
          addReason(`${currentFile}: sensitive build/toolchain configuration file modified`);
        }
      }
      continue;
    }

    const binaryMatch = BINARY_FILES_RE.exec(rawLine);
    if (binaryMatch !== null) {
      const binA = normalizeDiffPath(binaryMatch[1] ?? binaryMatch[2] ?? "");
      const binB = normalizeDiffPath(binaryMatch[3] ?? binaryMatch[4] ?? "");
      for (const candidate of [binA, binB]) {
        if (candidate.length > 0 && classifyFilePathRisk(candidate) !== "none") {
          addReason(`${candidate}: binary change on CI/build configuration file (fail-closed)`);
        }
      }
      continue;
    }

    if (rawLine === "GIT binary patch" && currentFile.length > 0 && currentCategory !== "none") {
      addReason(`${currentFile}: binary patch on CI/build configuration file (fail-closed)`);
      continue;
    }

    const hunkMatch = HUNK_HEADER_RE.exec(rawLine);
    if (hunkMatch !== null) {
      oldRemaining = hunkMatch[2] !== undefined ? Number.parseInt(hunkMatch[2], 10) : 1;
      newRemaining = hunkMatch[4] !== undefined ? Number.parseInt(hunkMatch[4], 10) : 1;
    }
  }

  return {
    detected: reasons.length > 0,
    reasons,
  };
}

/**
 * 巨大 PR（406 diff too large）時に `/pulls/{number}/files` 一覧から
 * `ci_script_hazard` を fail-closed で検査する。
 */
export function detectCiScriptHazardInFiles(
  files: readonly PullRequestFileEntry[],
  truncated: boolean,
): CiScriptHazardResult {
  const reasons: string[] = [];
  const addReason = (reason: string) => {
    if (!reasons.includes(reason)) {
      reasons.push(reason);
    }
  };

  if (truncated) {
    addReason("pull request file list was truncated; forcing static_only (fail-closed)");
  }

  for (const file of files) {
    const paths = [file.filename, ...(file.previousFilename ? [file.previousFilename] : [])].map(
      normalizeDiffPath,
    );

    let effectiveCategory: FileRiskCategory = "none";
    for (const path of paths) {
      const category = classifyFilePathRisk(path);
      if (category === "unconditional") {
        addReason(`${path}: sensitive build/toolchain configuration file modified`);
        effectiveCategory = "unconditional";
      } else if (category !== "none" && effectiveCategory === "none") {
        effectiveCategory = category;
      }
    }

    if (effectiveCategory === "none" || effectiveCategory === "unconditional") {
      continue;
    }

    const primaryPath = normalizeDiffPath(file.filename);
    if (file.patch === undefined) {
      addReason(`${primaryPath}: patch omitted for CI/build configuration file (fail-closed)`);
      continue;
    }

    for (const line of file.patch.split(/\r?\n/)) {
      if (line.startsWith("+") && !line.startsWith("+++")) {
        inspectAddedLine(primaryPath, effectiveCategory, line.slice(1), addReason);
      }
    }
  }

  return {
    detected: reasons.length > 0,
    reasons,
  };
}

function classifyFilePathRisk(filePath: string): FileRiskCategory {
  const normalized = normalizeDiffPath(filePath);
  if (normalized.length === 0) {
    return "none";
  }
  if (UNCONDITIONAL_HAZARD_DIR_SEGMENT_RE.test(normalized)) {
    return "unconditional";
  }
  const lower = normalized.toLowerCase();
  const withLeadingSlash = `/${lower}`;
  for (const suffix of UNCONDITIONAL_HAZARD_SUFFIXES) {
    if (withLeadingSlash.endsWith(suffix)) {
      return "unconditional";
    }
  }

  const basename = normalized.slice(normalized.lastIndexOf("/") + 1);
  if (UNCONDITIONAL_HAZARD_BASENAMES.has(basename) || TEST_RUNNER_CONFIG_RE.test(basename)) {
    return "unconditional";
  }
  if (basename === "package.json") {
    return "package_json";
  }
  if (basename === "Cargo.toml") {
    return "cargo_toml";
  }
  if (basename === "pyproject.toml") {
    return "pyproject_toml";
  }
  return "none";
}

function inspectAddedLine(
  filePath: string,
  category: FileRiskCategory,
  addedLine: string,
  addReason: (reason: string) => void,
): void {
  if (category === "none") {
    return;
  }

  const normalizedLine =
    category === "package_json" ? decodeJsonUnicodeEscapes(addedLine) : addedLine;

  if (category === "package_json") {
    const lifecycleMatch = PACKAGE_JSON_LIFECYCLE_KEY_RE.exec(normalizedLine);
    if (lifecycleMatch !== null) {
      addReason(
        `${filePath}: modified package lifecycle/manager field "${lifecycleMatch[0].trim()}"`,
      );
    }
    const execOrUrlMatch = PACKAGE_JSON_EXEC_OR_URL_RE.exec(normalizedLine);
    if (execOrUrlMatch !== null) {
      addReason(
        `${filePath}: modified package script/dependency target "${execOrUrlMatch[0].trim().slice(0, 60)}"`,
      );
    }
  }

  if (category === "pyproject_toml") {
    const pyprojectMatch = PYPROJECT_EXEC_OR_INDEX_RE.exec(normalizedLine);
    if (pyprojectMatch !== null) {
      addReason(`${filePath}: modified Python build/index/test hook "${pyprojectMatch[0].trim()}"`);
    }
  }

  if (category === "cargo_toml") {
    const cargoMatch = CARGO_TOML_EXEC_HOOK_RE.exec(normalizedLine);
    if (cargoMatch !== null) {
      addReason(`${filePath}: modified Cargo compile-time hook "${cargoMatch[0].trim()}"`);
    }
  }

  const hazardMatch = CI_SCRIPT_HAZARD_RE.exec(normalizedLine);
  if (hazardMatch !== null) {
    const snippet = hazardMatch[0].trim().slice(0, 60);
    addReason(`${filePath}: hazardous payload "${snippet}" in added CI/build config line`);
  }
}

/** JSON 内の `\uXXXX` エスケープを復元してブラックリスト回避を防ぐ。 */
function decodeJsonUnicodeEscapes(input: string): string {
  return input.replace(/\\u([0-9a-fA-F]{4})/g, (_match, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

function parseDiffHeaderPath(line: string, prefix: string): string | null {
  if (!line.startsWith(prefix)) {
    return null;
  }
  const rest = line.slice(prefix.length).trim();
  if (rest === "/dev/null") {
    return "/dev/null";
  }
  const tabIndex = rest.indexOf("\t");
  const withoutTimestamp = tabIndex === -1 ? rest : rest.slice(0, tabIndex);
  const unquoted =
    withoutTimestamp.startsWith('"') && withoutTimestamp.endsWith('"')
      ? withoutTimestamp.slice(1, -1)
      : withoutTimestamp;
  const stripped = unquoted.replace(/^[ab]\//, "");
  return normalizeDiffPath(stripped);
}

function normalizeDiffPath(raw: string): string {
  return raw
    .trim()
    .replace(/^"(.*)"$/, "$1")
    .replace(/^\.\//, "");
}
