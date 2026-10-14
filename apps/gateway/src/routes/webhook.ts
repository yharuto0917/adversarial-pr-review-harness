import { Hono } from "hono";

/** GitHub webhook 受け口。署名検証 → dedupe → Orchestrator DO へ委譲。 */
export const webhookRoutes = new Hono();

webhookRoutes.post("/github", (c) => {
  // TODO: verifyWebhookSignature → delivery id で dedupe → env.ORCHESTRATOR の stub へ
  return c.json({ ok: false, reason: "not implemented" }, 501);
});
