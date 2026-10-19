import { bindSandbox, createReviewModels, parseModelRef } from "@repo/harness";
import { DEFAULT_REVIEW_MODEL, VAULT_INSTANCE_NAME, vaultCredentials } from "@repo/orchestrator";
import { Hono } from "hono";

/**
 * 運用者向けの操作。`Authorization: Bearer <ADMIN_TOKEN>` が必須。
 *
 * Sign in with ChatGPT の認証情報は、手元でログインしてから登録する:
 *   npx @earendil-works/pi-ai login openai
 *   jq .openai auth.json | curl -X PUT --data @- \
 *     -H "Authorization: Bearer $ADMIN_TOKEN" https://<gateway>/admin/credentials/openai
 * 登録後は POST /admin/credentials/openai/verify で、更新と推論が通るかを確かめられる。
 */
export const adminRoutes = new Hono<{ Bindings: Env }>();

adminRoutes.use(async (c, next) => {
  const presented = c.req.header("authorization")?.replace(/^Bearer /, "");
  if (!c.env.ADMIN_TOKEN || !presented || !(await sameSecret(presented, c.env.ADMIN_TOKEN))) {
    return c.json({ ok: false, reason: "unauthorized" }, 401);
  }
  await next();
});

adminRoutes.get("/credentials", async (c) => {
  const vault = c.env.VAULT.getByName(VAULT_INSTANCE_NAME);
  return c.json({ ok: true, credentials: await vault.status() });
});

adminRoutes.put("/credentials/:providerId", async (c) => {
  const credential = await c.req.json().catch(() => undefined);
  const vault = c.env.VAULT.getByName(VAULT_INSTANCE_NAME);
  const result = await vault.importCredential(c.req.param("providerId"), credential);
  return c.json(result, result.ok ? 200 : 400);
});

/**
 * 登録済みの認証情報で、モデルに短い問い合わせを 1 回送る。
 * レビュー時と同じく vault 経由でトークンを受け取るので、期限切れなら更新も実際に走る。
 * モデルは `?model=<provider>/<id>` で指定でき、省略時は REVIEW_MODEL を使う。
 */
adminRoutes.post("/credentials/:providerId/verify", async (c) => {
  const providerId = c.req.param("providerId");
  const env = c.env as unknown as Record<string, string | undefined>;
  let ref: ReturnType<typeof parseModelRef>;
  try {
    ref = parseModelRef(c.req.query("model") ?? env.REVIEW_MODEL ?? DEFAULT_REVIEW_MODEL);
  } catch (error) {
    return c.json({ ok: false, reason: String(error) }, 400);
  }
  if (ref.provider !== providerId) {
    return c.json(
      { ok: false, reason: `model provider ${ref.provider} does not match ${providerId}` },
      400,
    );
  }

  const vault = c.env.VAULT.getByName(VAULT_INSTANCE_NAME);
  const models = createReviewModels({
    credentials: vaultCredentials(vault),
    env: (name) => env[name],
  });
  const model = models.getModel(ref.provider, ref.id);
  if (!model) {
    return c.json({ ok: false, reason: `unknown model: ${ref.provider}/${ref.id}` }, 400);
  }

  const expiresBefore = await expiresOf(vault, providerId);
  try {
    const message = await models.complete(model, {
      messages: [
        { role: "user", content: "Reply with the single word OK.", timestamp: Date.now() },
      ],
    });
    const reply = message.content
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("")
      .slice(0, 200);
    const expiresAfter = await expiresOf(vault, providerId);
    const ok = message.stopReason !== "error" && message.stopReason !== "aborted";
    return c.json(
      {
        ok,
        model: `${ref.provider}/${ref.id}`,
        stopReason: message.stopReason,
        reply,
        ...(message.errorMessage ? { error: message.errorMessage } : {}),
        // トークンそのものは返さず、更新が起きたかどうかだけを期限の変化で示す
        expiresBefore,
        expiresAfter,
        refreshed: expiresBefore !== expiresAfter,
      },
      ok ? 200 : 502,
    );
  } catch (error) {
    // 更新の失敗（リフレッシュトークンの失効など）はここに来る
    return c.json({ ok: false, model: `${ref.provider}/${ref.id}`, error: describe(error) }, 502);
  }
});

/**
 * RUNNER binding (SandboxEntrypoint) 経由で writeFile / readFile / listFiles / exec の
 * 4 操作を順に呼び、すべてサンドボックスまで届いて結果が返るかを確かめる。
 */
adminRoutes.post("/sandbox/verify", async (c) => {
  const sandboxId = c.req.query("sandboxId") ?? "verify";
  const sandbox = bindSandbox(c.env.RUNNER, sandboxId);
  const fileName = "verify.txt";
  const content = `verified-${Date.now()}`;
  try {
    await sandbox.writeFile(fileName, content);
    const read = await sandbox.readFile(fileName);
    const files = await sandbox.listFiles(".");
    const exec = await sandbox.exec(`cat ${fileName}`);
    const ok =
      read === content &&
      files.includes(fileName) &&
      exec.exitCode === 0 &&
      exec.stdout.trim() === content;
    return c.json({ ok, sandboxId, read, files, exec }, ok ? 200 : 502);
  } catch (error) {
    return c.json({ ok: false, sandboxId, error: describe(error) }, 502);
  }
});

async function expiresOf(
  vault: ReturnType<Env["VAULT"]["getByName"]>,
  providerId: string,
): Promise<number | null> {
  const statuses = await vault.status();
  return statuses.find((status) => status.providerId === providerId)?.expires ?? null;
}

/** 原因の連鎖ごと文字列にする。ModelsError は cause に上流の失敗を持つ。 */
function describe(error: unknown): string {
  const parts: string[] = [];
  for (let current = error; current !== undefined && parts.length < 5; ) {
    parts.push(current instanceof Error ? current.message : String(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  return parts.join(" <- ");
}

/** 長さの違いも含めて比較時間から内容が漏れないよう、ハッシュ同士を定数時間で比べる。 */
async function sameSecret(presented: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(presented)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}
