import { Hono } from "hono";

import { adminRoutes } from "./routes/admin.js";
import { apiRoutes } from "./routes/api.js";
import { webhookRoutes } from "./routes/webhook.js";

// Durable Object クラスは Worker のエントリから re-export する必要がある
export { CredentialVault, ReviewOrchestrator } from "@repo/orchestrator";

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ ok: true }));
app.route("/webhook", webhookRoutes);
app.route("/api", apiRoutes);
app.route("/admin", adminRoutes);

export default app;
