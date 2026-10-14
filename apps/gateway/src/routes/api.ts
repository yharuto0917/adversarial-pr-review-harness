import { Hono } from "hono";

/** dashboard 向けの REST。履歴・メトリクス・承認操作。 */
export const apiRoutes = new Hono();

apiRoutes.get("/runs", (c) => {
  // TODO: 実装
  return c.json({ ok: false, reason: "not implemented" }, 501);
});

apiRoutes.post("/runs/:runId/approve", (c) => {
  // TODO: 実装
  return c.json({ ok: false, reason: "not implemented" }, 501);
});
