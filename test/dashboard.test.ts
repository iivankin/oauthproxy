import { afterEach, expect, test } from "bun:test";
import { once } from "node:events";
import { Stats } from "../src/stats.ts";
import { fixture, openSocket } from "./codex-fixture.ts";

const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
async function setup() { const f = await fixture(); fixtures.push(f); return f; }
afterEach(async () => { for (const f of fixtures.splice(0)) await f.close(); });

test("dashboard is public, escapes metadata, and shows only the configured client credential", async () => {
  const f = await setup();
  await f.accounts.store.update(data => { data.accounts[0]!.name = '<script>alert("secret")</script>'; });
  f.usage.set("Bearer a-access", { rate_limit: { allowed: true, limit_reached: false,
    primary_window: { used_percent: 100, limit_window_seconds: 18000, reset_at: 1800000000 } },
    email: "codex@test.invalid", plan_type: "prolite" });
  const response = await fetch(`${f.url}dashboard`);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/html");
  expect(response.headers.get("cache-control")).toBe("no-store, no-transform");
  expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  const html = await response.text();
  expect(html).toContain("&lt;script&gt;alert(&quot;secret&quot;)&lt;/script&gt;");
  expect(html).toContain("test@invalid");
  expect(html).toContain("codex@test.invalid");
  expect(html).toContain("Max");
  expect(html).toContain("Pro Lite");
  expect(html).toContain("Bearer local-key");
  expect(html).toContain("POST /v1/messages");
  expect(html).toContain("POST /v1/responses (SSE)");
  expect(html).toContain('id="claude-oauth-start"');
  expect(html).toContain('id="codex-oauth-start"');
  expect(html).toContain("/admin/claude/oauth/complete");
  expect(response.headers.get("content-security-policy")).toMatch(/script-src 'nonce-[0-9a-f-]+'/);
  expect(html).toContain("100%");
  expect(html).toContain("5h");
  expect(html).not.toContain("Quota exhausted"); // Rounded 100% does not override allowed=true.
  for (const secret of ["a-access", "b-access", "a-refresh", "claude-token", "<script>"])
    expect(html).not.toContain(secret);
  expect((await fetch(`${f.url}codex/accounts`)).status).toBe(401);
  expect((await fetch(`${f.url}v1/responses`, { method: "POST" })).status).toBe(401);
});

test("dashboard shows per-account HTTP attempts and WS sessions without counting page views", async () => {
  const f = await setup();
  await f.accounts.store.update(data => { data.accounts.find(a => a.id === f.b.id)!.disabled = true; });
  const headers = { authorization: "Bearer local-key", "content-type": "application/json", "session-id": "dashboard-test" };
  const body = JSON.stringify({ model: "test-model", input: "Hi", stream: true });
  await (await fetch(`${f.url}v1/responses`, { method: "POST", headers, body })).text();
  f.options.onResponses = () => new Response("limited", { status: 429 });
  await (await fetch(`${f.url}v1/responses`, { method: "POST", headers, body })).text();
  const { socket } = await openSocket(f.wsUrl);
  let html = await (await fetch(`${f.url}dashboard`)).text();
  expect(html).toMatch(/<td>A<\/td><td>Codex<\/td><td>HTTP<\/td>\s*<td>2<\/td><td>0<\/td><td>1<\/td><td>1<\/td><td>0<\/td>/);
  expect(html).toMatch(/<td>WS<\/td>\s*<td>1<\/td><td>1<\/td><td>0<\/td>/);
  const closed = once(socket, "close");
  socket.close(1000);
  await closed;
  html = await (await fetch(`${f.url}dashboard`)).text();
  expect(html).toMatch(/<td>WS<\/td>\s*<td>1<\/td><td>0<\/td><td>1<\/td>/);
  expect(html).toContain("Disabled");
});

test("HTTP statistics observe EOF, cancellation and failures without consuming ahead", async () => {
  const stats = new Stats();
  const signal = new AbortController();
  let pulls = 0, cancelled = false;
  const response = await stats.http("Codex", "a", signal.signal, async () => new Response(new ReadableStream({
    pull(controller) { pulls++; controller.enqueue(new TextEncoder().encode("event: ping\n\n")); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 })));
  expect(pulls).toBe(0);
  expect(stats.snapshot()[0]!.active).toBe(1);
  const reader = response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("event: ping\n\n");
  expect(pulls).toBe(1);
  await reader.cancel();
  signal.abort(); // Must not count twice.
  expect(cancelled).toBe(true);
  const ok = await stats.http("Codex", "a", new AbortController().signal, async () => new Response("ok"));
  expect(await ok.text()).toBe("ok");
  const failed = await stats.http("Codex", "a", new AbortController().signal, async () => new Response(new ReadableStream({
    pull(controller) { controller.error(new Error("broken stream")); },
  })));
  await expect(failed.text()).rejects.toThrow("broken stream");
  await expect(stats.http("Codex", "a", new AbortController().signal, async () => { throw new Error("offline"); })).rejects.toThrow("offline");
  expect(stats.snapshot()).toEqual([{ provider: "Codex", account: "a", transport: "HTTP", total: 4,
    active: 0, completed: 1, cancelled: 1, errors: 2 }]);
});
