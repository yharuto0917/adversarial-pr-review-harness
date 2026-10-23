import { generateKeyPairSync } from "node:crypto";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
});

export default defineConfig({
  test: {
    testTimeout: 15_000,
  },
  plugins: [
    cloudflareTest({
      // ReviewOrchestrator を擬似モデル版に差し替えたエントリを使う
      main: "./test/worker.ts",
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // 実コンテナ (pr-review-runner) の代わりに、test/worker.ts の SandboxEntrypoint へ RPC で繋ぐ
        serviceBindings: {
          RUNNER: { name: "pr-review-gateway", entrypoint: "SandboxEntrypoint" },
        },
        bindings: {
          ADMIN_TOKEN: "test-admin-token",
          GITHUB_APP_ID: "12345",
          GITHUB_APP_PRIVATE_KEY: privateKey,
          GITHUB_WEBHOOK_SECRET: "test-webhook-secret",
          REVIEW_MODEL: "faux/faux-1",
        },
        // 差し替え前の ReviewOrchestrator。vault・GitHubPort との配線を本物のまま確かめるために残す
        durableObjects: {
          PRODUCTION_ORCHESTRATOR: { className: "ProductionOrchestrator", useSQLite: true },
        },
      },
    }),
  ],
});
