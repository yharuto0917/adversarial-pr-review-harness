import { WorkerEntrypoint } from "cloudflare:workers";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { ExecResult, SandboxExecOptions, SandboxService } from "@repo/harness";
import { ReviewOrchestrator as ProductionOrchestrator } from "@repo/orchestrator";

export { CredentialVault, default } from "../src/index.js";
export { ProductionOrchestrator };

/** テストから台本を差し込むための擬似モデル。`REVIEW_MODEL` は `faux/faux-1` を指す。 */
export const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });

/** サンドボックスに届いたコマンドの記録。 */
export const executed: string[] = [];

/** サンドボックスに届いた exec 呼び出し（コマンド + エグレス指定）の記録。 */
export const executedCalls: Array<{
  readonly sandboxId: string;
  readonly command: string;
  readonly options: SandboxExecOptions | undefined;
}> = [];

/** sandboxId ごとのインメモリファイルシステム。 */
export const sandboxFiles = new Map<string, Map<string, string>>();

/** destroy() が成功した sandboxId の記録。 */
export const destroyedSandboxes: string[] = [];

/** テストから破棄失敗・ハング・タイムアウト・TTL 短縮を注入するための設定。 */
export const sandboxTestConfig = {
  destroyFailuresRemaining: 0,
  hangCommand: null as string | null,
  checkoutTimeoutSha: null as string | null,
  maxLifetimeMs: null as number | null,
  cleanupPollMs: null as number | null,
  destroyRetryBaseDelayMs: null as number | null,
};

const sandboxDestroyCounts = new Map<string, number>();

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
  /GIT_TERMINAL_PROMPT=0\s+git\s+fetch\s+--depth\s+1\s+https:\/\/github\.com\/([^\s]+?)\.git\s+(?:--\s+)?([^\s&]+)/;

const INSTALL_COMMAND_PATTERN =
  /^(?:corepack\s+(?:npm|pnpm|yarn)@[0-9A-Za-z.-]+\s+|(?:npm|pnpm|yarn)\s+)(?:ci|install(?: --frozen-lockfile)?)$/;

const TEST_COMMAND_PATTERN =
  /^(?:corepack\s+(?:npm|pnpm|yarn)@[0-9A-Za-z.-]+\s+|(?:npm|pnpm|yarn)\s+)(?:test|run\s+\S+)$/;

/**
 * RUNNER service binding のテスト用 RPC 実装。
 * ReviewOrchestrator.ports() の sandbox は差し替えず、本番と同じく RUNNER への RPC を通す。
 */
export class SandboxEntrypoint extends WorkerEntrypoint implements SandboxService {
  async exec(
    sandboxId: string,
    command: string,
    options?: SandboxExecOptions,
  ): Promise<ExecResult> {
    executed.push(command);
    executedCalls.push({ sandboxId, command, options });
    const fetchMatch = command.match(GIT_FETCH_PATTERN);
    if (fetchMatch) {
      const [, repo, sha] = fetchMatch;
      const checkoutToken =
        options?.egress?.profile === "checkout" ? options.egress.githubToken : undefined;
      if (options?.egress?.profile === "checkout" && options.egress.resetContainer) {
        filesOf(sandboxId).clear();
      }
      if (sha === "fail-sha") {
        const leaked = checkoutToken ? btoa(`x-access-token:${checkoutToken}`) : "no-token";
        return {
          stdout: "fetch output",
          stderr: `fatal: authentication failed (${leaked})`,
          exitCode: 128,
        };
      }
      if (sha !== undefined && sha === sandboxTestConfig.checkoutTimeoutSha) {
        const leaked = checkoutToken ? btoa(`x-access-token:${checkoutToken}`) : "no-token";
        return {
          stdout: "",
          stderr: `command timed out after 120000ms (${leaked})`,
          exitCode: 124,
          timedOut: true,
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
    if (sandboxTestConfig.hangCommand !== null && command === sandboxTestConfig.hangCommand) {
      // Workers の cross-request I/O 制限に抵触しないよう、別リクエストから reject を直接呼ばず
      // 同一リクエストコンテキスト内のタイマーで destroy カウンタ変化を監視する
      const destroyCountAtStart = sandboxDestroyCounts.get(sandboxId) ?? 0;
      return new Promise<ExecResult>((_resolve, reject) => {
        const timer = setInterval(() => {
          if ((sandboxDestroyCounts.get(sandboxId) ?? 0) > destroyCountAtStart) {
            clearInterval(timer);
            reject(new Error("The sandbox was destroyed while the operation was pending."));
          }
        }, 10);
      });
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

  async destroy(sandboxId: string): Promise<void> {
    if (sandboxTestConfig.destroyFailuresRemaining > 0) {
      sandboxTestConfig.destroyFailuresRemaining -= 1;
      throw new Error("simulated sandbox destroy failure");
    }
    destroyedSandboxes.push(sandboxId);
    sandboxDestroyCounts.set(sandboxId, (sandboxDestroyCounts.get(sandboxId) ?? 0) + 1);
    sandboxFiles.delete(sandboxId);
  }
}

/** モデルだけを擬似モデルに差し替えた ReviewOrchestrator。PiHarness・SQLite・RUNNER RPC・GitHubPort 配線は本物を使う。 */
export class ReviewOrchestrator extends ProductionOrchestrator {
  protected override createModels() {
    const models = createModels();
    models.setProvider(faux.provider);
    return models;
  }

  protected override sandboxMaxLifetimeMs(): number {
    return sandboxTestConfig.maxLifetimeMs ?? super.sandboxMaxLifetimeMs();
  }

  protected override sandboxCleanupPollMs(): number {
    return sandboxTestConfig.cleanupPollMs ?? super.sandboxCleanupPollMs();
  }

  protected override sandboxDestroyRetryBaseDelayMs(): number {
    return sandboxTestConfig.destroyRetryBaseDelayMs ?? super.sandboxDestroyRetryBaseDelayMs();
  }
}
