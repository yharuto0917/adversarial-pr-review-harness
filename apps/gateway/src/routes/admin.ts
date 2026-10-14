import { VAULT_INSTANCE_NAME } from "@repo/orchestrator";
import { Hono } from "hono";

/**
 * 運用者向けの操作。`Authorization: Bearer <ADMIN_TOKEN>` が必須。
 *
 * Sign in with ChatGPT の認証情報は、手元でログインしてから登録する:
 *   npx @earendil-works/pi-ai login openai
 *   jq .openai auth.json | curl -X PUT --data @- \
 *     -H "Authorization: Bearer $ADMIN_TOKEN" https://<gateway>/admin/credentials/openai
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

/** 長さの違いも含めて比較時間から内容が漏れないよう、ハッシュ同士を定数時間で比べる。 */
async function sameSecret(presented: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(presented)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}
