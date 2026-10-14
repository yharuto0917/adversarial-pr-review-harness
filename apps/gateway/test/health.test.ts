import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("gateway", () => {
  it("/health が 200 を返す", async () => {
    const response = await SELF.fetch("https://example.com/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });
});
