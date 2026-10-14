import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // 実 Worker (pr-review-runner) はローカルに存在しないため、
        // service binding はテスト用のスタブで置き換える
        serviceBindings: {
          RUNNER: () => new Response(null, { status: 501 }),
        },
      },
    }),
  ],
});
