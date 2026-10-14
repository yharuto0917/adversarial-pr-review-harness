import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      // ReviewOrchestrator を擬似モデル版に差し替えたエントリを使う
      main: "./test/worker.ts",
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // 実 Worker (pr-review-runner) はローカルに存在しないため、
        // service binding はテスト用のスタブで置き換える
        serviceBindings: {
          RUNNER: () => new Response(null, { status: 501 }),
        },
        bindings: { ADMIN_TOKEN: "test-admin-token", REVIEW_MODEL: "faux/faux-1" },
        // 差し替え前の ReviewOrchestrator。vault との配線を本物のまま確かめるために残す
        durableObjects: {
          PRODUCTION_ORCHESTRATOR: { className: "ProductionOrchestrator", useSQLite: true },
        },
      },
    }),
  ],
});
