import { afterEach, expect, test } from "bun:test";
import { fixture } from "./codex-fixture.ts";

const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
async function setup(config?: Parameters<typeof fixture>[0]) { const f = await fixture(config); fixtures.push(f); return f; }
afterEach(async () => { for (const f of fixtures.splice(0)) await f.close(); });
const headers = { authorization: "Bearer local-key", "content-type": "application/json" };
const post = (url: string, value: unknown, extra: Record<string, string> = {}) =>
  fetch(url, { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(value) });

test("admin OAuth routes require a configured and valid proxy API key", async () => {
  const f = await setup();
  expect((await fetch(`${f.url}admin/codex/oauth/start`, { method: "POST",
    headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(401);
  expect((await post(`${f.url}admin/codex/oauth/start`, {}, { origin: "https://example.test" })).status).toBe(403);
  expect(f.calls.filter(call => call.path.includes("deviceauth"))).toHaveLength(0);

  const withoutKey = await setup({ key: null });
  const response = await fetch(`${withoutKey.url}admin/codex/oauth/start`, { method: "POST",
    headers: { "content-type": "application/json" }, body: "{}" });
  expect(response.status).toBe(503);
  expect(await response.text()).toContain("PROXY_API_KEY");
});

test("Claude admin flow exchanges code, stores the account and never returns tokens", async () => {
  const f = await setup();
  const started = await post(`${f.url}admin/claude/oauth/start`, { name: "Remote Claude" });
  expect(started.status).toBe(201);
  const start = await started.json() as { flowId: string; authorizationUrl: string };
  const state = new URL(start.authorizationUrl).searchParams.get("state");
  expect(state).toBeTruthy();

  const rejected = await post(`${f.url}admin/claude/oauth/complete`, { flowId: start.flowId, code: "code#wrong" });
  expect(rejected.status).toBe(400);
  const completed = await post(`${f.url}admin/claude/oauth/complete`, { flowId: start.flowId, code: `code#${state}` });
  expect(completed.status).toBe(200);
  const text = await completed.text();
  expect(text).toContain("Remote Claude");
  expect(text).toContain("new@test.invalid");
  for (const secret of ["claude-new-token", "claude-new-refresh", "accessToken", "refreshToken"])
    expect(text).not.toContain(secret);
  expect((await post(`${f.url}admin/claude/oauth/complete`, { flowId: start.flowId, code: `code#${state}` })).status).toBe(404);
});

test("Codex admin flow returns the device code and exposes only safe completion state", async () => {
  const f = await setup();
  const started = await post(`${f.url}admin/codex/oauth/start`, { name: "Remote Codex" });
  expect(started.status).toBe(201);
  const startText = await started.text();
  expect(startText).toContain("ABCD");
  expect(startText).toContain("/codex/device");
  for (const secret of ["device_auth_id", "a-refreshed", "a-refresh-rotated", "access_token", "refresh_token"])
    expect(startText).not.toContain(secret);
  const start = JSON.parse(startText) as { flowId: string };

  let result: Record<string, unknown> = {};
  for (let attempt = 0; attempt < 20; attempt++) {
    const response = await fetch(`${f.url}admin/oauth/${start.flowId}`, { headers: { authorization: "Bearer local-key" } });
    expect(response.status).toBe(200);
    result = await response.json() as Record<string, unknown>;
    if (result.status !== "pending") break;
    await Bun.sleep(10);
  }
  expect(result.status).toBe("completed");
  const text = JSON.stringify(result);
  expect(text).toContain("Remote Codex");
  for (const secret of ["deviceAuthId", "a-refreshed", "a-refresh-rotated", "accessToken", "refreshToken"])
    expect(text).not.toContain(secret);
});
