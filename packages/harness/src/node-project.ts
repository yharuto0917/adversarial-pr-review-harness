import type { SandboxPort } from "./ports.js";

export type PackageManager = "npm" | "pnpm" | "yarn";

export interface NodeProjectInfo {
  readonly packageManager: PackageManager;
  readonly installCommand: string;
  readonly testCommands: readonly string[];
}

export type NodeProjectSetupResult =
  | {
      readonly detected: false;
      readonly testCommands: readonly [];
    }
  | ({
      readonly detected: true;
    } & NodeProjectInfo);

const AUXILIARY_CHECK_SCRIPTS = ["typecheck", "type-check", "check", "check:ci", "lint"] as const;
const DEFAULT_NPM_INIT_TEST_MARKER = "no test specified";
const SAFE_SCRIPT_NAME = /^[A-Za-z0-9_.:-]+$/;
const SAFE_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * `package.json` の内容とルートファイル一覧から、
 * パッケージマネージャ・依存インストールコマンド・テストコマンド候補を特定する。
 */
export function detectNodeProject(
  packageJsonContent: string,
  rootFiles: readonly string[],
): NodeProjectInfo {
  const pkg = parsePackageJson(packageJsonContent);
  const fileSet = new Set(rootFiles.map(normalizeRootFileName));
  const { packageManager, runner } = resolvePackageManager(pkg.packageManager, fileSet);
  const installCommand = resolveInstallCommand(packageManager, runner, fileSet);
  const testCommands = extractTestCommands(runner, pkg.scripts);

  return {
    packageManager,
    installCommand,
    testCommands,
  };
}

/**
 * サンドボックスのルートに `package.json` が存在する場合、
 * パッケージマネージャを検出して依存をインストールし、テストコマンド候補を返す。
 */
export async function setupNodeProject(sandbox: SandboxPort): Promise<NodeProjectSetupResult> {
  const rootFiles = await sandbox.listFiles(".");
  const fileSet = new Set(rootFiles.map(normalizeRootFileName));
  if (!fileSet.has("package.json")) {
    return { detected: false, testCommands: [] };
  }

  const packageJsonContent = await sandbox.readFile("package.json");
  const info = detectNodeProject(packageJsonContent, rootFiles);
  const result = await sandbox.exec(info.installCommand);

  if (result.exitCode !== 0) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    throw new Error(
      `failed to install dependencies with "${info.installCommand}" (exit ${result.exitCode})${detail ? `: ${detail}` : ""}`,
    );
  }

  return {
    detected: true,
    packageManager: info.packageManager,
    installCommand: info.installCommand,
    testCommands: info.testCommands,
  };
}

interface ParsedPackageJson {
  readonly packageManager: string | undefined;
  readonly scripts: Readonly<Record<string, string>> | undefined;
}

function parsePackageJson(raw: string): ParsedPackageJson {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to parse package.json: ${reason}`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("failed to parse package.json: root must be an object");
  }

  const record = parsed as Record<string, unknown>;
  const packageManager =
    typeof record.packageManager === "string" ? record.packageManager : undefined;

  let scripts: Record<string, string> | undefined;
  if (
    typeof record.scripts === "object" &&
    record.scripts !== null &&
    !Array.isArray(record.scripts)
  ) {
    scripts = {};
    for (const [key, value] of Object.entries(record.scripts as Record<string, unknown>)) {
      if (typeof value === "string" && value.trim().length > 0) {
        scripts[key] = value;
      }
    }
  }

  return { packageManager, scripts };
}

function normalizeRootFileName(file: string): string {
  return file.replace(/^\.\//, "");
}

interface ResolvedPackageManager {
  readonly packageManager: PackageManager;
  readonly runner: string;
}

function resolvePackageManager(
  packageManagerField: string | undefined,
  fileSet: ReadonlySet<string>,
): ResolvedPackageManager {
  if (packageManagerField) {
    const trimmed = packageManagerField.trim();
    const atIndex = trimmed.indexOf("@");
    const name = (atIndex === -1 ? trimmed : trimmed.slice(0, atIndex)).trim();
    const rawVersion = atIndex === -1 ? "" : trimmed.slice(atIndex + 1).trim();
    const version = rawVersion.split("+")[0]?.trim() ?? "";

    if (name === "pnpm" || name === "yarn" || name === "npm") {
      if (rawVersion.length > 0) {
        if (!SAFE_VERSION.test(version)) {
          throw new Error(`invalid packageManager version in package.json: ${packageManagerField}`);
        }
        return {
          packageManager: name,
          runner: `corepack ${name}@${version}`,
        };
      }
      return { packageManager: name, runner: name };
    }
  }

  if (fileSet.has("pnpm-lock.yaml")) {
    return { packageManager: "pnpm", runner: "pnpm" };
  }
  if (fileSet.has("yarn.lock")) {
    return { packageManager: "yarn", runner: "yarn" };
  }
  if (fileSet.has("package-lock.json") || fileSet.has("npm-shrinkwrap.json")) {
    return { packageManager: "npm", runner: "npm" };
  }

  return { packageManager: "npm", runner: "npm" };
}

function resolveInstallCommand(
  packageManager: PackageManager,
  runner: string,
  fileSet: ReadonlySet<string>,
): string {
  switch (packageManager) {
    case "pnpm":
      return fileSet.has("pnpm-lock.yaml")
        ? `${runner} install --frozen-lockfile`
        : `${runner} install`;
    case "yarn":
      return fileSet.has("yarn.lock") ? `${runner} install --frozen-lockfile` : `${runner} install`;
    case "npm":
      return fileSet.has("package-lock.json") || fileSet.has("npm-shrinkwrap.json")
        ? `${runner} ci`
        : `${runner} install`;
  }
}

function extractTestCommands(
  runner: string,
  scripts: Readonly<Record<string, string>> | undefined,
): string[] {
  if (!scripts) {
    return [];
  }

  const commands: string[] = [];

  const testBody = scripts.test;
  if (testBody && !testBody.toLowerCase().includes(DEFAULT_NPM_INIT_TEST_MARKER)) {
    commands.push(formatScriptCommand(runner, "test"));
  }

  for (const name of Object.keys(scripts)) {
    if (
      name.startsWith("test:") &&
      SAFE_SCRIPT_NAME.test(name) &&
      !name.toLowerCase().includes("watch")
    ) {
      commands.push(formatScriptCommand(runner, name));
    }
  }

  for (const aux of AUXILIARY_CHECK_SCRIPTS) {
    if (scripts[aux]) {
      commands.push(formatScriptCommand(runner, aux));
    }
  }

  return commands;
}

export function formatScriptCommand(runner: string, scriptName: string): string {
  if (scriptName === "test") {
    return `${runner} test`;
  }
  return `${runner} run ${scriptName}`;
}
