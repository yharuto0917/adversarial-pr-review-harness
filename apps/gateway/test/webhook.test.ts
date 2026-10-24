import { env, SELF } from "cloudflare:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { clearInstallationTokenCache } from "@repo/github";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { faux } from "./worker.js";

const WEBHOOK_SECRET = "test-webhook-secret";

async function signPayload(payload: string, secret: string = WEBHOOK_SECRET): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)));
  const hex = [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `sha256=${hex}`;
}

function makePullRequestPayload(
  action: string,
  repository = "octo/repo",
  pullNumber = 10,
  headSha = "deadbeef",
  installationId = 777,
) {
  return JSON.stringify({
    action,
    number: pullNumber,
    pull_request: {
      number: pullNumber,
      head: { sha: headSha },
    },
    repository: { full_name: repository },
    installation: { id: installationId },
  });
}

describe("POST /webhook/github", () => {
  beforeEach(() => {
    clearInstallationTokenCache();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/app/installations/777/access_tokens")) {
          const expiresAt = new Date(Date.now() + 3600_000).toISOString();
          return Response.json({ token: "ghs_inst_777", expires_at: expiresAt }, { status: 201 });
        }
        return new Response("unexpected url", { status: 404 });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ["署名ヘッダなし", undefined],
    ["誤った署名", "sha256=0000000000000000000000000000000000000000000000000000000000000000"],
    ["不正な形式の署名", "sha1=deadbeef"],
  ])("%s の場合は 401 を返し、レビューを開始しない", async (_label, signature) => {
    const callsBefore = faux.state.callCount;
    const body = makePullRequestPayload("opened", "octo/repo", 101);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-github-event": "pull_request",
      "x-github-delivery": "delivery-unauth-1",
    };
    if (signature !== undefined) {
      headers["x-hub-signature-256"] = signature;
    }

    const response = await SELF.fetch("https://example.com/webhook/github", {
      method: "POST",
      headers,
      body,
    });

    expect(response.status).toBe(401);
    expect(faux.state.callCount).toBe(callsBefore);
  });

  it("pull_request 以外のイベントや対象外 action は 202 で無視し、レビューを開始しない", async () => {
    const callsBefore = faux.state.callCount;

    const pingBody = JSON.stringify({ zen: "Keep it logically awesome." });
    const pingRes = await SELF.fetch("https://example.com/webhook/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "ping",
        "x-github-delivery": "delivery-ping-1",
        "x-hub-signature-256": await signPayload(pingBody),
      },
      body: pingBody,
    });
    expect(pingRes.status).toBe(202);
    await expect(pingRes.json()).resolves.toMatchObject({ ok: true, ignored: true });

    for (const action of ["closed", "edited", "labeled"]) {
      const body = makePullRequestPayload(action, "octo/repo", 102);
      const res = await SELF.fetch("https://example.com/webhook/github", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "pull_request",
          "x-github-delivery": `delivery-${action}`,
          "x-hub-signature-256": await signPayload(body),
        },
        body,
      });
      expect(res.status).toBe(202);
      await expect(res.json()).resolves.toMatchObject({ ok: true, ignored: true });
    }

    expect(faux.state.callCount).toBe(callsBefore);
  });

  it.each(["opened", "synchronize", "reopened"] as const)(
    "pull_request (%s) で owner/name#番号 の DO に start() を呼び 202 を返す",
    async (action) => {
      faux.setResponses([fauxAssistantMessage(fauxText(`reviewed-${action}`))]);
      const pullNumber = action === "opened" ? 201 : action === "synchronize" ? 202 : 203;
      const deliveryId = `delivery-${action}-${pullNumber}`;
      const body = makePullRequestPayload(action, "octo/repo", pullNumber, "sha123");

      const response = await SELF.fetch("https://example.com/webhook/github", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "pull_request",
          "x-github-delivery": deliveryId,
          "x-hub-signature-256": await signPayload(body),
        },
        body,
      });

      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toEqual({
        ok: true,
        deliveryId,
        accepted: true,
      });

      const orchestrator = env.ORCHESTRATOR.getByName(`octo/repo#${pullNumber}`);
      const result = await orchestrator.result(deliveryId);
      expect(result).toMatchObject({ status: "done", text: `reviewed-${action}` });
    },
  );

  it("同じ delivery id の再送では二重に実行されない", async () => {
    faux.setResponses([fauxAssistantMessage(fauxText("once"))]);
    const callsBefore = faux.state.callCount;
    const deliveryId = "delivery-duplicate-301";
    const body = makePullRequestPayload("opened", "octo/repo", 301, "sha-dup");
    const signature = await signPayload(body);
    const headers = {
      "content-type": "application/json",
      "x-github-event": "pull_request",
      "x-github-delivery": deliveryId,
      "x-hub-signature-256": signature,
    };

    const first = await SELF.fetch("https://example.com/webhook/github", {
      method: "POST",
      headers,
      body,
    });
    const orchestrator = env.ORCHESTRATOR.getByName("octo/repo#301");
    await orchestrator.result(deliveryId);

    const second = await SELF.fetch("https://example.com/webhook/github", {
      method: "POST",
      headers,
      body,
    });

    expect(first.status).toBe(202);
    await expect(first.json()).resolves.toEqual({ ok: true, deliveryId, accepted: true });
    expect(second.status).toBe(202);
    await expect(second.json()).resolves.toEqual({ ok: true, deliveryId, accepted: false });
    expect(faux.state.callCount - callsBefore).toBe(1);
  });
});
