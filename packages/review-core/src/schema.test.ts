import { describe, expect, it } from "vitest";

import { findingSchema } from "./schema.js";

describe("findingSchema", () => {
  it("最小構成の指摘をパースできる", () => {
    const parsed = findingSchema.parse({
      fingerprint: "abc123",
      path: "src/index.ts",
      line: 10,
      severity: "major",
      title: "境界値が未処理",
      body: "空配列のときに例外になる。",
    });

    expect(parsed.severity).toBe("major");
  });
});
