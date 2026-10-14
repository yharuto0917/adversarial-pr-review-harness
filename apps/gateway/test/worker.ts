import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { HarnessPorts } from "@repo/harness";
import { ReviewOrchestrator as ProductionOrchestrator } from "@repo/orchestrator";

export { CredentialVault, default } from "../src/index.js";
export { ProductionOrchestrator };

/** テストから台本を差し込むための擬似モデル。`REVIEW_MODEL` は `faux/faux-1` を指す。 */
export const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });

/** サンドボックスに届いたコマンドの記録。 */
export const executed: string[] = [];

/** モデルと外部依存だけを差し替えた ReviewOrchestrator。PiHarness と SQLite は本物を使う。 */
export class ReviewOrchestrator extends ProductionOrchestrator {
  protected override createModels() {
    const models = createModels();
    models.setProvider(faux.provider);
    return models;
  }

  protected override ports(): HarnessPorts {
    return {
      ...super.ports(),
      sandbox: {
        exec: async (command) => {
          executed.push(command);
          return { stdout: "1 failed", stderr: "", exitCode: 1 };
        },
        readFile: async () => "",
        writeFile: async () => {},
        listFiles: async () => [],
      },
      github: {
        getDiff: async () => "diff --git a/src/sum.ts b/src/sum.ts",
        postReview: async () => {},
        resolveThread: async () => {},
      },
    };
  }
}
