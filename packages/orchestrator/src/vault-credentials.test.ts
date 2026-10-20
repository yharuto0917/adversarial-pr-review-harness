import { createReviewModels } from "@repo/harness";
import { describe, expect, it } from "vitest";

import { vaultCredentials } from "./vault-credentials.js";

function fakeVault(tokens: string[]) {
  const asked: string[] = [];
  return {
    asked,
    resolve: async (providerId: string) => {
      asked.push(providerId);
      const key = tokens.shift();
      return key ? ({ type: "api_key", key } as const) : undefined;
    },
  };
}

describe("vaultCredentials", () => {
  it("OpenAI は解決のたびに vault へ問い合わせ、その時点のアクセストークンを使う", async () => {
    const vault = fakeVault(["token-1", "token-2"]);
    const models = createReviewModels({
      credentials: vaultCredentials(vault),
      env: () => undefined,
    });

    const first = await models.getAuth("openai");
    const second = await models.getAuth("openai");

    expect(first?.auth.apiKey).toBe("token-1");
    expect(second?.auth.apiKey).toBe("token-2");
  });

  it("vault に未登録の OpenAI は、環境変数の API キーにフォールバックしない限り未設定になる", async () => {
    const vault = fakeVault([]);
    const models = createReviewModels({
      credentials: vaultCredentials(vault),
      env: () => undefined,
    });

    await expect(models.getAuth("openai")).resolves.toBeUndefined();
  });

  it("API キーのプロバイダは vault に問い合わせず、環境変数から解決する", async () => {
    const vault = fakeVault(["unused"]);
    const models = createReviewModels({
      credentials: vaultCredentials(vault),
      env: (name) => {
        if (name === "ANTHROPIC_API_KEY") return "anthropic-key";
        if (name === "OPENCODE_API_KEY") return "opencode-key";
        if (name === "OPENROUTER_API_KEY") return "openrouter-key";
        return undefined;
      },
    });

    const anthropicAuth = await models.getAuth("anthropic");
    const opencodeAuth = await models.getAuth("opencode");
    const openrouterAuth = await models.getAuth("openrouter");

    expect(anthropicAuth?.auth.apiKey).toBe("anthropic-key");
    expect(opencodeAuth?.auth.apiKey).toBe("opencode-key");
    expect(openrouterAuth?.auth.apiKey).toBe("openrouter-key");
    expect(vault.asked).toEqual([]);
  });

  it("書き込みは受け付けない", async () => {
    const store = vaultCredentials(fakeVault([]));

    await expect(store.modify("openai", async () => undefined)).rejects.toThrow(/read-only/);
    await expect(store.delete("openai")).rejects.toThrow(/read-only/);
  });
});
