import { verifyWebhookSignature } from "@repo/github";
import { Hono } from "hono";

const SUPPORTED_ACTIONS = new Set(["opened", "synchronize", "reopened"]);

interface PullRequestWebhookPayload {
  readonly action?: unknown;
  readonly number?: unknown;
  readonly pull_request?: {
    readonly number?: unknown;
    readonly head?: {
      readonly sha?: unknown;
    };
  };
  readonly repository?: {
    readonly full_name?: unknown;
  };
  readonly installation?: {
    readonly id?: unknown;
  };
}

/** GitHub webhook 受け口。署名検証 → 対象イベント判定 → Orchestrator DO へ委譲。 */
export const webhookRoutes = new Hono<{ Bindings: Env }>();

webhookRoutes.post("/github", async (c) => {
  const rawBody = await c.req.text();
  const signature = c.req.header("x-hub-signature-256");
  const valid = await verifyWebhookSignature(rawBody, signature, c.env.GITHUB_WEBHOOK_SECRET);
  if (!valid) {
    return c.json({ ok: false, reason: "invalid signature" }, 401);
  }

  const event = c.req.header("x-github-event");
  if (event !== "pull_request") {
    return c.json(
      { ok: true, ignored: true, reason: `unsupported event: ${event ?? "none"}` },
      202,
    );
  }

  let payload: PullRequestWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as PullRequestWebhookPayload;
  } catch {
    return c.json({ ok: false, reason: "invalid json" }, 400);
  }

  if (typeof payload.action !== "string" || !SUPPORTED_ACTIONS.has(payload.action)) {
    return c.json(
      { ok: true, ignored: true, reason: `unsupported action: ${String(payload.action)}` },
      202,
    );
  }

  const deliveryId = c.req.header("x-github-delivery");
  const repository = payload.repository?.full_name;
  const pullNumber = payload.pull_request?.number ?? payload.number;
  const headSha = payload.pull_request?.head?.sha;
  const installationId = payload.installation?.id;

  if (
    typeof deliveryId !== "string" ||
    deliveryId.length === 0 ||
    typeof repository !== "string" ||
    repository.length === 0 ||
    typeof pullNumber !== "number" ||
    !Number.isInteger(pullNumber) ||
    typeof headSha !== "string" ||
    headSha.length === 0
  ) {
    return c.json({ ok: false, reason: "invalid pull_request payload" }, 400);
  }

  const orchestrator = c.env.ORCHESTRATOR.getByName(`${repository}#${pullNumber}`);
  const receipt = await orchestrator.start({
    deliveryId,
    repository,
    pullNumber,
    headSha,
    ...(typeof installationId === "number" ? { installationId } : {}),
  });

  return c.json({ ok: true, deliveryId: receipt.operationId, accepted: receipt.accepted }, 202);
});
