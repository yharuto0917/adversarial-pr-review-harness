import { WorkerEntrypoint } from "cloudflare:workers";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { ExecResult, SandboxService } from "@repo/harness";
import { ReviewOrchestrator as ProductionOrchestrator } from "@repo/orchestrator";

export { CredentialVault, default } from "../src/index.js";
export { ProductionOrchestrator };

/** テストから台本を差し込むための擬似モデル。`REVIEW_MODEL` は `faux/faux-1` を指す。 */
export const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });

/** サンドボックスに届いたコマンドの記録。 */
export const executed: string[] = [];

/** sandboxId ごとのインメモリファイルシステム。 */
export const sandboxFiles = new Map<string, Map<string, string>>();

/** `<repository>@<headSha>` ごとに git fetch / checkout で展開されるリモートファイル群。 */
export const remoteRepoFiles = new Map<string, Record<string, string>>();

function filesOf(sandboxId: string): Map<string, string> {
  let files = sandboxFiles.get(sandboxId);
  if (!files) {
    files = new Map();
    sandboxFiles.set(sandboxId, files);
  }
  return files;
}

const GIT_FETCH_PATTERN =
  /git\s+-c\s+"http\.extraHeader=Authorization:\s+Basic\s+([^"]+)"\s+fetch\s+--depth\s+1\s+https:\/\/github\.com\/([^\s]+?)\.git\s+(?:--\s+)?([^\s&]+)/;

const INSTALL_COMMAND_PATTERN =
  /^(?:npm (?:ci|install)|pnpm install(?: --frozen-lockfile)?|yarn install(?: --frozen-lockfile)?)$/;

const TEST_COMMAND_PATTERN = /^(?:npm|pnpm|yarn)\s+(?:test|run\s+\S+)$/;

/**
 * RUNNER service binding のテスト用 RPC 実装。
 * ReviewOrchestrator.ports() の sandbox は差し替えず、本番と同じく RUNNER への RPC を通す。
 */
export class SandboxEntrypoint extends WorkerEntrypoint implements SandboxService {
  async exec(sandboxId: string, command: string): Promise<ExecResult> {
    executed.push(command);
    const fetchMatch = command.match(GIT_FETCH_PATTERN);
    if (fetchMatch) {
      const [, basicAuth, repo, sha] = fetchMatch;
      if (sha === "fail-sha") {
        return {
          stdout: "fetch output",
          stderr: `fatal: authentication failed (${basicAuth})`,
          exitCode: 128,
        };
      }
      const files = filesOf(sandboxId);
      files.clear();
      const repoFiles = remoteRepoFiles.get(`${repo}@${sha}`) ?? remoteRepoFiles.get(sha ?? "");
      if (repoFiles) {
        for (const [path, content] of Object.entries(repoFiles)) {
          files.set(path, content);
        }
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    if (INSTALL_COMMAND_PATTERN.test(command)) {
      const files = filesOf(sandboxId);
      if (files.get("package.json")?.includes('"fail-install"')) {
        return {
          stdout: "",
          stderr: "ERR_INSTALL_FAILED: registry error",
          exitCode: 1,
        };
      }
      files.set("node_modules/.installed", command);
      return { stdout: `installed via ${command}`, stderr: "", exitCode: 0 };
    }
    if (TEST_COMMAND_PATTERN.test(command) && filesOf(sandboxId).has("node_modules/.installed")) {
      return {
        stdout: `PASS (${command})`,
        stderr: "",
        exitCode: 0,
      };
    }
    if (command.startsWith("cat ")) {
      const path = command.slice("cat ".length).trim();
      const content = filesOf(sandboxId).get(path);
      if (content === undefined) {
        return { stdout: "", stderr: `cat: ${path}: No such file or directory`, exitCode: 1 };
      }
      return { stdout: content, stderr: "", exitCode: 0 };
    }
    return { stdout: "1 failed", stderr: "", exitCode: 1 };
  }

  async readFile(sandboxId: string, path: string): Promise<string> {
    const content = filesOf(sandboxId).get(path);
    if (content === undefined) {
      throw new Error(`ENOENT: ${path}`);
    }
    return content;
  }

  async writeFile(sandboxId: string, path: string, content: string): Promise<void> {
    filesOf(sandboxId).set(path, content);
  }

  async listFiles(sandboxId: string, _path: string): Promise<string[]> {
    return [...filesOf(sandboxId).keys()];
  }
}

/** モデルだけを擬似モデルに差し替えた ReviewOrchestrator。PiHarness・SQLite・RUNNER RPC・GitHubPort 配線は本物を使う。 */
export class ReviewOrchestrator extends ProductionOrchestrator {
  protected override createModels() {
    const models = createModels();
    models.setProvider(faux.provider);
    return models;
  }
}
