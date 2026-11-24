import { detectNodeProject } from "./node-project.js";
import type { SandboxPort } from "./ports.js";

export type ProjectEcosystem = "node" | "python" | "go" | "rust";

export interface DetectedProject {
  readonly ecosystem: ProjectEcosystem;
  readonly tool: string;
  readonly installCommand: string;
  readonly testCommands: readonly string[];
}

export interface ProjectDetectionResult {
  readonly detected: boolean;
  readonly projects: readonly DetectedProject[];
  readonly testCommands: readonly string[];
}

export interface ProjectManifestFiles {
  readonly packageJson?: string;
  readonly pyprojectToml?: string;
  readonly requirementsFiles?: Readonly<Record<string, string>>;
}

const PYTHON_REQUIREMENTS_FILES = [
  "requirements.txt",
  "requirements-dev.txt",
  "requirements-test.txt",
  "dev-requirements.txt",
  "test-requirements.txt",
] as const;

const PYTEST_HINT_FILES = ["pytest.ini", "conftest.py"] as const;
const PYPROJECT_PROJECT_SECTION = /^\s*\[project\]\s*(?:#.*)?$/m;
const PYPROJECT_BUILD_SYSTEM_SECTION = /^\s*\[build-system\]\s*(?:#.*)?$/m;
const PYTEST_TOKEN = /\bpytest\b/i;
const RUFF_TOKEN = /\bruff\b/i;
const MYPY_TOKEN = /\bmypy\b/i;

/**
 * ルートファイル一覧とマニフェスト内容から、対応する言語・エコシステムの
 * 依存インストールコマンドとテストコマンド候補を特定する純粋関数。
 *
 * 複数言語が共存するリポジトリ（例: Node.js + Python / Go / Rust）にも対応し、
 * 検出された全エコシステムの情報を返す。
 */
export function detectProjects(
  rootFiles: readonly string[],
  manifests: ProjectManifestFiles = {},
): ProjectDetectionResult {
  const fileSet = new Set(rootFiles.map(normalizeRootFileName));
  const projects: DetectedProject[] = [];

  if (fileSet.has("package.json") && manifests.packageJson !== undefined) {
    const node = detectNodeProject(manifests.packageJson, rootFiles);
    projects.push({
      ecosystem: "node",
      tool: node.packageManager,
      installCommand: node.installCommand,
      testCommands: node.testCommands,
    });
  }

  const python = detectPythonProject(fileSet, manifests);
  if (python !== null) {
    projects.push(python);
  }

  if (fileSet.has("go.mod")) {
    projects.push({
      ecosystem: "go",
      tool: "go",
      installCommand: "go mod download",
      testCommands: ["go test ./...", "go vet ./..."],
    });
  }

  if (fileSet.has("Cargo.toml")) {
    projects.push({
      ecosystem: "rust",
      tool: "cargo",
      installCommand: fileSet.has("Cargo.lock") ? "cargo fetch --locked" : "cargo fetch",
      testCommands: ["cargo test --offline", "cargo clippy --offline --all-targets"],
    });
  }

  return {
    detected: projects.length > 0,
    projects,
    testCommands: dedupeStrings(projects.flatMap((project) => project.testCommands)),
  };
}

/**
 * サンドボックスのルートを走査してマニフェストを読み込み、
 * 対応エコシステムの構成とテストコマンド候補を検出する（コマンドは実行しない）。
 */
export async function inspectProject(sandbox: SandboxPort): Promise<ProjectDetectionResult> {
  const rootFiles = await sandbox.listFiles(".");
  const fileSet = new Set(rootFiles.map(normalizeRootFileName));

  let packageJson: string | undefined;
  if (fileSet.has("package.json")) {
    packageJson = await sandbox.readFile("package.json");
  }

  let pyprojectToml: string | undefined;
  if (fileSet.has("pyproject.toml")) {
    pyprojectToml = await sandbox.readFile("pyproject.toml");
  }

  const requirementsFiles: Record<string, string> = {};
  for (const filename of PYTHON_REQUIREMENTS_FILES) {
    if (fileSet.has(filename)) {
      requirementsFiles[filename] = await sandbox.readFile(filename);
    }
  }

  return detectProjects(rootFiles, {
    ...(packageJson !== undefined ? { packageJson } : {}),
    ...(pyprojectToml !== undefined ? { pyprojectToml } : {}),
    ...(Object.keys(requirementsFiles).length > 0 ? { requirementsFiles } : {}),
  });
}

/**
 * サンドボックスのプロジェクト構成を検出し、各エコシステムの依存をセットアップした上で
 * モデルに提示するテストコマンド候補を返す。
 */
export async function setupProject(sandbox: SandboxPort): Promise<ProjectDetectionResult> {
  const detection = await inspectProject(sandbox);
  if (!detection.detected) {
    return detection;
  }

  for (const project of detection.projects) {
    const result = await sandbox.exec(project.installCommand);
    if (result.timedOut) {
      const detail = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
      throw new Error(
        `timed out while installing dependencies with "${project.installCommand}" (exit ${result.exitCode})${detail ? `: ${detail}` : ""}`,
      );
    }
    if (result.exitCode !== 0) {
      const detail = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
      throw new Error(
        `failed to install dependencies with "${project.installCommand}" (exit ${result.exitCode})${detail ? `: ${detail}` : ""}`,
      );
    }
  }

  return detection;
}

function detectPythonProject(
  fileSet: ReadonlySet<string>,
  manifests: ProjectManifestFiles,
): DetectedProject | null {
  const hasPyproject = fileSet.has("pyproject.toml");
  const reqFiles = PYTHON_REQUIREMENTS_FILES.filter((filename) => fileSet.has(filename));

  if (!hasPyproject && reqFiles.length === 0) {
    return null;
  }

  const pyprojectContent = manifests.pyprojectToml ?? "";
  const reqContents = reqFiles.map((filename) => manifests.requirementsFiles?.[filename] ?? "");
  const combinedConfigText = [pyprojectContent, ...reqContents].join("\n");

  const hasPytest =
    PYTEST_HINT_FILES.some((file) => fileSet.has(file)) || PYTEST_TOKEN.test(combinedConfigText);
  const hasRuff = RUFF_TOKEN.test(combinedConfigText);
  const hasMypy = MYPY_TOKEN.test(combinedConfigText);

  if (hasPyproject && fileSet.has("uv.lock")) {
    return {
      ecosystem: "python",
      tool: "uv",
      installCommand: "uv sync --frozen",
      testCommands: buildUvRunCommands(hasPytest, hasRuff, hasMypy),
    };
  }

  if (hasPyproject && PYPROJECT_PROJECT_SECTION.test(pyprojectContent)) {
    return {
      ecosystem: "python",
      tool: "uv",
      installCommand: "uv sync",
      testCommands: buildUvRunCommands(hasPytest, hasRuff, hasMypy),
    };
  }

  if (reqFiles.length > 0) {
    const reqArgs = reqFiles.map((filename) => `-r ${filename}`).join(" ");
    return {
      ecosystem: "python",
      tool: "uv",
      installCommand: `uv venv .venv && uv pip install --python .venv/bin/python ${reqArgs}`,
      testCommands: buildVenvCommands(hasPytest, hasRuff, hasMypy),
    };
  }

  if (hasPyproject && PYPROJECT_BUILD_SYSTEM_SECTION.test(pyprojectContent)) {
    return {
      ecosystem: "python",
      tool: "uv",
      installCommand: "uv venv .venv && uv pip install --python .venv/bin/python -e .",
      testCommands: buildVenvCommands(hasPytest, hasRuff, hasMypy),
    };
  }

  // [project] / [build-system] / requirements いずれも無い pyproject.toml のみの場合は
  // 仮想環境だけ作成し、uv sync による失敗を避ける
  return {
    ecosystem: "python",
    tool: "uv",
    installCommand: "uv venv .venv",
    testCommands: buildVenvCommands(hasPytest, hasRuff, hasMypy),
  };
}

function buildUvRunCommands(hasPytest: boolean, hasRuff: boolean, hasMypy: boolean): string[] {
  const prefix = "uv run --offline --no-sync";
  const commands: string[] = [hasPytest ? `${prefix} pytest` : `${prefix} python -m unittest`];
  if (hasRuff) {
    commands.push(`${prefix} ruff check .`);
  }
  if (hasMypy) {
    commands.push(`${prefix} mypy .`);
  }
  return commands;
}

function buildVenvCommands(hasPytest: boolean, hasRuff: boolean, hasMypy: boolean): string[] {
  const commands: string[] = [hasPytest ? ".venv/bin/pytest" : ".venv/bin/python -m unittest"];
  if (hasRuff) {
    commands.push(".venv/bin/ruff check .");
  }
  if (hasMypy) {
    commands.push(".venv/bin/mypy .");
  }
  return commands;
}

function normalizeRootFileName(file: string): string {
  return file.replace(/^\.\//, "");
}

function dedupeStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}
