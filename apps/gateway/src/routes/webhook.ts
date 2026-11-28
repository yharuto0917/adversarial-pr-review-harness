import { verifyWebhookSignature } from "@repo/github";
import { Hono } from "hono";

const SUPPORTED_PR_REVIEW_ACTIONS = new Set(["opened", "synchronize", "reopened"]);
const SAFE_REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** Webhook ペイロードの最大許容バイト数（2 MiB）。 */
export const MAX_WEBHOOK_BODY_BYTES = 2 * 1024 * 1024;

/** 1 回の `check_suite.completed` で通知する PR 上限件数（サブリクエスト枯渇防止）。 */
export const MAX_CHECK_SUITE_PULL_REQUESTS = 20;

export interface WebhookRepoRef {
  readonly id?: unknown;
  readonly full_name?: unknown;
  readonly default_branch?: unknown;
}

interface PullRequestWebhookPayload {
  readonly action?: unknown;
  readonly number?: unknown;
  readonly pull_request?: {
    readonly number?: unknown;
    readonly base?: {
      readonly sha?: unknown;
      readonly repo?: WebhookRepoRef | null;
    };
    readonly head?: {
      readonly sha?: unknown;
      readonly repo?: WebhookRepoRef | null;
    };
  };
  readonly repository?: WebhookRepoRef;
  readonly installation?: {
    readonly id?: unknown;
  };
}

interface CheckSuitePullRequestRef {
  readonly number?: unknown;
  readonly head?: {
    readonly sha?: unknown;
  };
  readonly base?: {
    readonly repo?: {
      readonly id?: unknown;
    };
  };
}

interface CheckSuiteWebhookPayload {
  readonly action?: unknown;
  readonly check_suite?: {
    readonly id?: unknown;
    readonly head_sha?: unknown;
    readonly conclusion?: unknown;
    readonly app?: {
      readonly id?: unknown;
    };
    readonly pull_requests?: unknown;
  };
  readonly repository?: WebhookRepoRef;
}

/** GitHub webhook 受け口。署名検証 → 対象イベント判定 → Orchestrator DO へ委譲。 */
export const webhookRoutes = new Hono<{ Bindings: Env }>();

webhookRoutes.post("/github", async (c) => {
  const rawBody = await c.req.text();
  if (new TextEncoder().encode(rawBody).byteLength > MAX_WEBHOOK_BODY_BYTES) {
    return c.json({ ok: false, reason: "payload too large" }, 413);
  }

  const signature = c.req.header("x-hub-signature-256");
  const valid = await verifyWebhookSignature(rawBody, signature, c.env.GITHUB_WEBHOOK_SECRET);
  if (!valid) {
    return c.json({ ok: false, reason: "invalid signature" }, 401);
  }

  const event = c.req.header("x-github-event");
  if (event !== "pull_request" && event !== "check_suite") {
    return c.json(
      { ok: true, ignored: true, reason: `unsupported event: ${event ?? "none"}` },
      202,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return c.json({ ok: false, reason: "invalid json" }, 400);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return c.json({ ok: false, reason: "invalid json object" }, 400);
  }

  const deliveryId = c.req.header("x-github-delivery");
  if (typeof deliveryId !== "string" || deliveryId.length === 0) {
    return c.json({ ok: false, reason: "missing x-github-delivery header" }, 400);
  }

  if (event === "check_suite") {
    return handleCheckSuiteWebhook(c.env, deliveryId, parsed as CheckSuiteWebhookPayload, c);
  }

  return handlePullRequestWebhook(c.env, deliveryId, parsed as PullRequestWebhookPayload, c);
});

async function handlePullRequestWebhook(
  env: Env,
  deliveryId: string,
  payload: PullRequestWebhookPayload,
  c: { json: (data: unknown, status: 202 | 400) => Response },
): Promise<Response> {
  if (typeof payload.action !== "string") {
    return c.json(
      { ok: true, ignored: true, reason: `unsupported action: ${String(payload.action)}` },
      202,
    );
  }

  const repository = payload.repository?.full_name;
  const pullNumber = payload.pull_request?.number ?? payload.number;

  if (payload.action === "closed") {
    if (!isSafeRepository(repository) || !isPositiveInteger(pullNumber)) {
      return c.json({ ok: false, reason: "invalid pull_request closed payload" }, 400);
    }
    const orchestrator = env.ORCHESTRATOR.getByName(`${repository}#${pullNumber}`);
    const closedReceipt = await orchestrator.handlePullRequestClosed({
      deliveryId,
      repository,
      pullNumber,
    });
    return c.json(
      {
        ok: true,
        deliveryId,
        action: "closed",
        destroyedSandbox: closedReceipt.destroyedSandbox,
        cancelledCiWait: closedReceipt.cancelledCiWait,
      },
      202,
    );
  }

  if (!SUPPORTED_PR_REVIEW_ACTIONS.has(payload.action)) {
    return c.json(
      { ok: true, ignored: true, reason: `unsupported action: ${payload.action}` },
      202,
    );
  }

  const headSha = payload.pull_request?.head?.sha;
  const baseShaRaw = payload.pull_request?.base?.sha;
  const defaultBranchRaw =
    payload.pull_request?.base?.repo?.default_branch ?? payload.repository?.default_branch;
  const installationId = payload.installation?.id;

  if (
    !isSafeRepository(repository) ||
    !isPositiveInteger(pullNumber) ||
    !isSafeRef(headSha) ||
    (baseShaRaw !== undefined && !isSafeRef(baseShaRaw)) ||
    (installationId !== undefined && !isPositiveInteger(installationId))
  ) {
    return c.json({ ok: false, reason: "invalid pull_request payload" }, 400);
  }

  const isFork = resolveWebhookIsFork(
    payload.pull_request?.base?.repo,
    payload.pull_request?.head?.repo,
  );
  const defaultBranch =
    typeof defaultBranchRaw === "string" && defaultBranchRaw.trim().length > 0
      ? defaultBranchRaw.trim()
      : undefined;

  const orchestrator = env.ORCHESTRATOR.getByName(`${repository}#${pullNumber}`);
  const receipt = await orchestrator.start({
    deliveryId,
    repository,
    pullNumber,
    headSha,
    ...(baseShaRaw !== undefined ? { baseSha: baseShaRaw } : {}),
    ...(defaultBranch !== undefined ? { defaultBranch } : {}),
    ...(isFork !== undefined ? { isFork } : {}),
    action: payload.action as "opened" | "synchronize" | "reopened",
    ...(installationId !== undefined ? { installationId } : {}),
  });

  return c.json({ ok: true, deliveryId: receipt.operationId, accepted: receipt.accepted }, 202);
}

async function handleCheckSuiteWebhook(
  env: Env,
  deliveryId: string,
  payload: CheckSuiteWebhookPayload,
  c: { json: (data: unknown, status: 202 | 400) => Response },
): Promise<Response> {
  if (payload.action !== "completed") {
    return c.json(
      {
        ok: true,
        ignored: true,
        reason: `unsupported check_suite action: ${String(payload.action)}`,
      },
      202,
    );
  }

  const suite = payload.check_suite;
  const suiteAppId = suite?.app?.id;
  if (
    typeof suiteAppId === "number" &&
    Number.isInteger(suiteAppId) &&
    typeof env.GITHUB_APP_ID === "string" &&
    env.GITHUB_APP_ID.trim().length > 0 &&
    String(suiteAppId) === env.GITHUB_APP_ID.trim()
  ) {
    return c.json({ ok: true, ignored: true, reason: "self app check_suite" }, 202);
  }

  const repository = payload.repository?.full_name;
  const repoId = isPositiveInteger(payload.repository?.id) ? payload.repository.id : undefined;
  const headSha = suite?.head_sha;
  if (!isSafeRepository(repository) || !isSafeRef(headSha)) {
    return c.json({ ok: false, reason: "invalid check_suite payload" }, 400);
  }

  const rawPulls = Array.isArray(suite?.pull_requests) ? suite.pull_requests : [];
  const pullNumbers: number[] = [];
  const seen = new Set<number>();
  for (const entry of rawPulls) {
    if (pullNumbers.length >= MAX_CHECK_SUITE_PULL_REQUESTS) {
      break;
    }
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const pr = entry as CheckSuitePullRequestRef;
    if (!isPositiveInteger(pr.number) || seen.has(pr.number)) {
      continue;
    }
    // クロスリポジトリの別 PR への誤通知を防止
    const prBaseRepoId = pr.base?.repo?.id;
    if (repoId !== undefined && isPositiveInteger(prBaseRepoId) && prBaseRepoId !== repoId) {
      continue;
    }
    seen.add(pr.number);
    pullNumbers.push(pr.number);
  }

  if (pullNumbers.length === 0) {
    return c.json({ ok: true, ignored: true, reason: "no associated pull requests" }, 202);
  }

  const checkSuiteId = isPositiveInteger(suite?.id) ? suite.id : undefined;
  const conclusion = typeof suite?.conclusion === "string" ? suite.conclusion : null;

  const settled = await Promise.allSettled(
    pullNumbers.map(async (pullNumber) => {
      const orchestrator = env.ORCHESTRATOR.getByName(`${repository}#${pullNumber}`);
      const res = await orchestrator.notifyCheckSuiteCompleted({
        deliveryId,
        repository,
        pullNumber,
        headSha,
        ...(checkSuiteId !== undefined ? { checkSuiteId } : {}),
        conclusion,
      });
      return { pullNumber, woken: res.woken };
    }),
  );

  const wokenPullNumbers: number[] = [];
  for (let i = 0; i < settled.length; i += 1) {
    const outcome = settled[i];
    if (outcome?.status === "fulfilled") {
      if (outcome.value.woken) {
        wokenPullNumbers.push(outcome.value.pullNumber);
      }
    } else if (outcome?.status === "rejected") {
      console.error({
        event: "webhook.check_suite.notify_error",
        deliveryId,
        repository,
        pullNumber: pullNumbers[i],
        error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
      });
    }
  }

  return c.json(
    {
      ok: true,
      deliveryId,
      notifiedPullNumbers: pullNumbers,
      wokenPullNumbers,
    },
    202,
  );
}

/**
 * Webhook ペイロードから外部フォーク PR かどうかを fail-closed で判定する。
 * `head.repo === null`（削除済みフォーク）は `true`、`base.repo` と `head.repo` の両方が
 * 正の id と full_name で一致した場合のみ `false`。情報欠落時は `undefined` として Step 0 へ委ねる。
 */
export function resolveWebhookIsFork(
  baseRepo: WebhookRepoRef | null | undefined,
  headRepo: WebhookRepoRef | null | undefined,
): boolean | undefined {
  if (headRepo === null) {
    return true;
  }
  if (baseRepo === undefined || baseRepo === null || headRepo === undefined) {
    return undefined;
  }

  const baseId = isPositiveInteger(baseRepo.id) ? baseRepo.id : null;
  const headId = isPositiveInteger(headRepo.id) ? headRepo.id : null;
  const baseName =
    typeof baseRepo.full_name === "string" && baseRepo.full_name.trim().length > 0
      ? baseRepo.full_name.trim().toLowerCase()
      : null;
  const headName =
    typeof headRepo.full_name === "string" && headRepo.full_name.trim().length > 0
      ? headRepo.full_name.trim().toLowerCase()
      : null;

  if (baseId !== null && headId !== null && baseName !== null && headName !== null) {
    return !(baseId === headId && baseName === headName);
  }
  if (baseId !== null && headId !== null && baseId !== headId) {
    return true;
  }
  if (baseName !== null && headName !== null && baseName !== headName) {
    return true;
  }
  // 判定材料が不完全な場合は fail-closed で true を返す
  return true;
}

function isSafeRepository(value: unknown): value is string {
  return typeof value === "string" && SAFE_REPOSITORY.test(value) && !value.includes("..");
}

function isSafeRef(value: unknown): value is string {
  return typeof value === "string" && SAFE_REF.test(value) && !value.includes("..");
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}
