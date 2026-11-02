import { afterEach, expect, test } from "bun:test";
import { fixture } from "./codex-fixture.ts";

const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
async function setup(config?: Parameters<typeof fixture>[0]) { const f = await fixture(config); fixtures.push(f); return f; }
afterEach(async () => { for (const f of fixtures.splice(0)) await f.close(); });
const headers = { authorization: "Bearer local-key", "content-type": "application/json" };
const consume = (url: string, input: unknown, extra: Record<string, string> = {}) =>
  fetch(url + "/consume", { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(input) });
const credit = { id: "credit-1", reset_type: "codex_rate_limits", status: "available",
  granted_at: "2026-10-01T00:00:00Z", expires_at: null, title: "Full reset (Weekly + 5 hr)" };

test("manual reset API requires auth, same origin, a valid body and an existing account", async () => {
  const f = await setup();
  const url = `${f.url}admin/codex/accounts/${f.a.id}/reset-credits`;
  const input = { credit_id: credit.id, redeem_request_id: crypto.randomUUID() };
  expect((await fetch(url)).status).toBe(401);
  expect((await fetch(url + "/consume", { method: "POST" })).status).toBe(401);
  expect((await consume(url, input, { origin: "https://attacker.invalid" })).status).toBe(403);
  expect((await consume(url, { credit_id: credit.id })).status).toBe(400);
  expect((await consume(url, { ...input, redeem_request_id: "bad-id" })).status).toBe(400);
  expect((await fetch(`${f.url}admin/codex/accounts/missing/reset-credits`, { headers })).status).toBe(404);
  expect(f.calls.filter(call => call.path.startsWith("/reset-credits"))).toHaveLength(0);
  const unconfigured = await setup({ key: null });
  expect((await fetch(`${unconfigured.url}admin/codex/accounts/${unconfigured.a.id}/reset-credits`)).status).toBe(503);
});

test("lists native reset details without OAuth secrets and sends the selected credit with an idempotency key", async () => {
  const f = await setup();
  const url = `${f.url}admin/codex/accounts/${f.a.id}/reset-credits`;
  f.options.resetCredits = { credits: [credit], available_count: 1, access_token: "must-not-leak" };
  const response = await fetch(url, { headers });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ credits: [credit], available_count: 1 });
  const input = { credit_id: credit.id, redeem_request_id: crypto.randomUUID() };
  const result = await consume(url, input, { origin: new URL(f.url).origin });
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual({ code: "reset", windows_reset: 2 });
  const call = f.calls.find(call => call.path.endsWith("/consume"))!;
  expect(JSON.parse(call.body)).toEqual(input);
  expect(call.headers.authorization).toBe("Bearer a-access");
  expect(call.headers["chatgpt-account-id"]).toBe("a");
  expect(call.headers["content-type"]).toBe("application/json");
});

test("confirmed reset invalidates cached quota and clears the exhaustion cooldown", async () => {
  const f = await setup();
  f.usage.set("Bearer a-access", { rate_limit: { allowed: false, limit_reached: true } });
  f.accounts.limit(f.a.id, { resets_at: Math.floor(Date.now() / 1000) + 3600 });
  await f.accounts.usage(f.a.id);
  await expect(f.accounts.choose("test-model", undefined, new Set([f.b.id]))).rejects.toThrow("No account");
  f.options.onConsumeReset = () => {
    f.usage.set("Bearer a-access", { rate_limit: { allowed: true, limit_reached: false } });
    return Response.json({ code: "reset", windows_reset: 2 });
  };
  await f.accounts.consumeReset(f.a.id, { credit_id: credit.id, redeem_request_id: crypto.randomUUID() });
  expect(await f.accounts.choose("test-model", undefined, new Set([f.b.id]))).toBe(f.a.id);
  expect(f.calls.filter(call => call.path === "/usage")).toHaveLength(2);
});

test("all native reset outcomes pass through; upstream errors are not retried on another account", async () => {
  const f = await setup();
  const url = `${f.url}admin/codex/accounts/${f.a.id}/reset-credits`;
  for (const code of ["nothing_to_reset", "no_credit", "already_redeemed"]) {
    f.options.onConsumeReset = () => Response.json({ code });
    const response = await consume(url, { credit_id: credit.id, redeem_request_id: crypto.randomUUID() });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ code, windows_reset: 0 });
  }
  f.options.onConsumeReset = () => new Response("internal upstream details", { status: 503 });
  const input = { credit_id: credit.id, redeem_request_id: crypto.randomUUID() };
  const response = await consume(url, input);
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("internal upstream details");
  const calls = f.calls.filter(call => call.path.endsWith("/consume"));
  expect(calls).toHaveLength(4);
  expect(calls.every(call => call.headers.authorization === "Bearer a-access")).toBe(true);
});

test("401 refresh retries the same reset operation with the same request ID", async () => {
  const f = await setup();
  let attempts = 0;
  f.options.onConsumeReset = () => ++attempts === 1
    ? new Response("expired", { status: 401 }) : Response.json({ code: "reset" });
  const input = { credit_id: credit.id, redeem_request_id: crypto.randomUUID() };
  await f.accounts.consumeReset(f.a.id, input);
  const calls = f.calls.filter(call => call.path.endsWith("/consume"));
  expect(calls.map(call => JSON.parse(call.body))).toEqual([input, input]);
  expect(calls.map(call => call.headers.authorization)).toEqual(["Bearer a-access", "Bearer a-refreshed"]);
});
