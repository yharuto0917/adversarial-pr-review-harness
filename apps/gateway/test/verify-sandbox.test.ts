import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { executed, sandboxFiles } from "./worker.js";

const authorized = { authorization: "Bearer test-admin-token" };

describe("POST /admin/sandbox/verify", () => {
  beforeEach(() => {
    executed.length = 0;
    sandboxFiles.clear();
  });

  it("RUNNER binding 経由で writeFile / readFile / listFiles / exec を呼び、結果が一致すれば 200 を返す", async () => {
    const response = await SELF.fetch("https://example.com/admin/sandbox/verify", {
      method: "POST",
      headers: authorized,
    });

    expect(response.status).toBe(200);
    const body = await response.json<{
      ok: boolean;
      sandboxId: string;
      read: string;
      files: string[];
      exec: { stdout: string; stderr: string; exitCode: number };
    }>();
    expect(body.ok).toBe(true);
    expect(body.sandboxId).toBe("verify");
    expect(body.read).toMatch(/^verified-\d+$/);
    expect(body.files).toContain("verify.txt");
    expect(body.exec).toEqual({
      stdout: body.read,
      stderr: "",
      exitCode: 0,
    });
    expect(executed).toEqual(["cat verify.txt"]);
  });

  it("クエリで指定した sandboxId を使う", async () => {
    const response = await SELF.fetch("https://example.com/admin/sandbox/verify?sandboxId=pr-42", {
      method: "POST",
      headers: authorized,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      sandboxId: "pr-42",
    });
    expect(sandboxFiles.has("pr-42")).toBe(true);
  });
});
