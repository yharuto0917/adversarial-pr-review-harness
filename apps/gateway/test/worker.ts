import { WorkerEntrypoint } from "cloudflare:workers";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { ExecResult, HarnessPorts, SandboxService } from "@repo/harness";
import { ReviewOrchestrator as ProductionOrchestrator } from "@repo/orchestrator";

export { CredentialVault, default } from "../src/index.js";
export { ProductionOrchestrator };

/** テストから台本を差し込むための擬似モデル。`REVIEW_MODEL` は `faux/faux-1` を指す。 */
export const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });

/** サンドボックスに届いたコマンドの記録。 */
export const executed: string[] = [];

/** sandboxId ごとのインメモリファイルシステム。 */
export const sandboxFiles = new Map<string, Map<string, string>>();

function filesOf(sandboxId: string): Map<string, string> {
  let files = sandboxFiles.get(sandboxId);
  if (!files) {
    files = new Map();
    sandboxFiles.set(sandboxId, files);
  }
  return files;
}

/**
 * RUNNER service binding のテスト用 RPC 実装。
 * ReviewOrchestrator.ports() の sandbox は差し替えず、本番と同じく RUNNER への RPC を通す。
 */
export class SandboxEntrypoint extends WorkerEntrypoint implements SandboxService {
  async exec(sandboxId: string, command: string): Promise<ExecResult> {
    executed.push(command);
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

/** モデルと GitHub だけを差し替えた ReviewOrchestrator。PiHarness・SQLite・RUNNER RPC 配線は本物を使う。 */
export class ReviewOrchestrator extends ProductionOrchestrator {
  protected override createModels() {
    const models = createModels();
    models.setProvider(faux.provider);
    return models;
  }

  protected override ports(): HarnessPorts {
    return {
      ...super.ports(),
      github: {
        getDiff: async () => "diff --git a/src/sum.ts b/src/sum.ts",
        postReview: async () => {},
        resolveThread: async () => {},
      },
    };
  }
}
