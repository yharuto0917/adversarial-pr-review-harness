import { describe, expect, it } from "vitest";

import { createReviewModels, parseModelRef } from "./models.js";

const emptyStore = {
  read: async () => undefined,
  list: async () => [],
  modify: async () => undefined,
  delete: async () => {},
};

describe("createReviewModels", () => {
  it("保存済みの認証情報が無いプロバイダは env の API キーで解決する", async () => {
    const models = createReviewModels({
      credentials: emptyStore,
      env: (name) => (name === "GEMINI_API_KEY" ? "gemini-key" : undefined),
    });

    await expect(models.getAuth("google")).resolves.toMatchObject({
      auth: { apiKey: "gemini-key" },
    });
    await expect(models.getAuth("anthropic")).resolves.toBeUndefined();
  });

  it("保存済みの認証情報は env より優先される", async () => {
    const models = createReviewModels({
      credentials: {
        ...emptyStore,
        read: async (providerId) =>
          providerId === "openai" ? { type: "api_key", key: "from-store" } : undefined,
      },
      env: (name) => (name === "OPENAI_API_KEY" ? "from-env" : undefined),
    });

    await expect(models.getAuth("openai")).resolves.toMatchObject({
      auth: { apiKey: "from-store" },
    });
  });
});

describe("parseModelRef", () => {
  it("provider と model id に分解する", () => {
    expect(parseModelRef("openai/gpt-6-sol")).toEqual({ provider: "openai", id: "gpt-6-sol" });
  });

  it("model id 側のスラッシュは保持する", () => {
    expect(parseModelRef("openrouter/vendor/model")).toEqual({
      provider: "openrouter",
      id: "vendor/model",
    });
  });

  it.each(["gpt-6-sol", "/gpt-6-sol", "openai/", ""])("%j は拒否する", (value) => {
    expect(() => parseModelRef(value)).toThrow();
  });
});
