import { Hono } from "hono";

import { apiRoutes } from "./routes/api.js";
import { webhookRoutes } from "./routes/webhook.js";

// Durable Object クラスは Worker のエントリから re-export する必要がある
export { ReviewOrchestrator } from "@repo/orchestrator";

const app = new Hono();

app.get("/health", (c) => c.json({ ok: true }));
app.route("/webhook", webhookRoutes);
app.route("/api", apiRoutes);

export default app;
