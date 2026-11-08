import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Accounts } from "../src/accounts.ts";
import { AccountStore } from "../src/store.ts";
import { Transport } from "../src/transport.ts";
import { serve } from "../src/server.ts";
import { claudeResetOffers } from "../src/claude-reset-schema.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
const grant = { id: "test_grant", label: "Full reset", resets_left: 2, clears: ["five_hour", "seven_day"],
  ends_at: "2030-01-01T00:00:00Z", usable_now: true, use_requires_limit: true, blocking: [], paused: false };
const status = () => ({ cedar_ember: { eligible: true, at_limit: true, exhausted: ["five_hour"], grants: [{ ...grant }] },
  juniper_tide: { eligible: true, available: true, arm: "reset" } });
const headers = { authorization: "Bearer local-key", "content-type": "application/json" };
const input = () => ({ credit_id: "cedar_ember:test_grant", redeem_request_id: crypto.randomUUID() });

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "claude-resets-"));
  const store = new AccountStore(join(directory, "accounts.json"));
  await store.update(data => { data.accounts.push({ id: "a", name: "A", email: "a@test.invalid", organizationId: "org",
    accountUuid: crypto.randomUUID(), deviceId: "a".repeat(64), accessToken: "a-access", refreshToken: "a-refresh",
    expiresAt: Date.now() + 3600_000, clientId: "test", scopes: [], disabled: false }); });
  const calls: { url: URL; headers: Headers; body?: string }[] = [];
  let used = 100;
  const options = { status: status(), onConsume: (): Response | Promise<Response> => {
    used = 0;
    return Response.json({ result: "reset", cleared: ["five_hour", "seven_day"], resets_left: 1 });
  } };
  const accounts = new Accounts(store, new Transport(async (url, init) => {
    const target = new URL(url);
    calls.push({ url: target, headers: new Headers(init?.headers), body: typeof init?.body === "string" ? init.body : undefined });
    if (target.pathname === "/token") return Response.json({ access_token: "a-new", expires_in: 3600 });
    if (target.pathname.endsWith("/reset_rate_limits")) return options.onConsume();
    if (target.pathname === "/v1/models") return Response.json({ data: [{ id: "test-model" }] });
    return Response.json({ five_hour: { utilization: used, resets_at: "2030-01-01T00:00:00Z" },
      seven_day: { utilization: 10, resets_at: null }, ...options.status, access_token: "do-not-leak" });
  }, "https://mock.invalid", "https://mock.invalid/token"));
  const server = serve(accounts, "127.0.0.1", 0, "local-key");
  cleanup.push(async () => { await server.stop(); await rm(directory, { recursive: true, force: true }); });
  const url = new URL("/admin/claude/accounts/a/reset-credits", server.url).toString();
  const consume = (body: unknown, extra: Record<string, string> = {}) => fetch(url + "/consume", {
    method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(body),
  });
  return { accounts, options, calls, url, consume };
}

test("Claude reset routes protect credentials and use native CLI headers only for reset calls", async () => {
  const f = await setup();
  expect((await fetch(f.url)).status).toBe(401);
  expect((await f.consume(input(), { origin: "https://foreign.invalid" })).status).toBe(403);
  expect((await f.consume({ ...input(), credit_id: "arbitrary" })).status).toBe(400);
  expect((await fetch(f.url.replace("/a/", "/missing/"), { headers })).status).toBe(404);
  expect(f.calls).toHaveLength(0);
  const response = await fetch(f.url, { headers });
  expect(response.headers.get("cache-control")).toBe("no-store");
  const text = await response.text();
  expect(text).not.toContain("do-not-leak");
  const list = JSON.parse(text);
  expect(list.available_count).toBe(3);
  expect(list.credits.map((credit: { id: string }) => credit.id)).toEqual(["cedar_ember:test_grant", "juniper_tide"]);
  expect(f.calls[0]!.url.search).toBe("?at_wall=1&skip_spend=1");
  expect(f.calls[0]!.headers.get("user-agent")).toBe("claude-cli/2.1.319 (external, cli)");
  expect(f.calls[0]!.headers.get("anthropic-beta")).toBe("oauth-2025-04-20");
  expect(f.calls[0]!.headers.get("authorization")).toBe("Bearer a-access");
  await f.accounts.usage("a");
  expect(f.calls.at(-1)!.headers.get("user-agent")).toContain("agent-sdk/");
});

test("Claude resets obey arm, cooldown, expiry and blocking gates before POST", async () => {
  const f = await setup();
  f.options.status.juniper_tide.arm = "control";
  let result = await f.consume({ ...input(), credit_id: "juniper_tide" });
  expect(result.status).toBe(409);
  expect((await f.accounts.resets.list("a")).available_count).toBe(2);
  for (const patch of [
    { paused: true }, { blocking: ["seven_day"] }, { ends_at: "2020-01-01T00:00:00Z" },
    { usable_now: false }, { starts_at: "2030-01-01T00:00:00Z" }, { ends_at: "bad-date" },
  ]) {
    const native = status();
    Object.assign(native.cedar_ember.grants[0]!, patch);
    expect(claudeResetOffers(native).credits[0]!.status).toBe("unavailable");
  }
  const cooling = { ...status(), cedar_ember: { ...status().cedar_ember, cooldown_until: "2030-01-01T00:00:00Z" } };
  expect(claudeResetOffers(cooling).credits[0]!.status).toBe("unavailable");
  f.options.status.cedar_ember.grants[0]!.usable_now = false;
  result = await f.consume(input());
  expect(result.status).toBe(409);
  expect(f.calls.filter(call => call.body)).toHaveLength(0);
});

test("manual Claude claim refreshes auth once, retains UUID and clears cached exhaustion", async () => {
  const f = await setup();
  await f.accounts.usage("a");
  f.accounts.limited("a", new Headers({ "retry-after": "3600" }));
  let attempts = 0;
  f.options.onConsume = () => ++attempts === 1
    ? Response.json({ error: { type: "authentication_error" } }, { status: 401 })
    : Response.json({ result: "reset", cleared: ["five_hour"], resets_left: 1 });
  const operation = input();
  const response = await f.consume(operation);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ code: "reset", windows_reset: 1 });
  const posts = f.calls.filter(call => call.url.pathname.endsWith("/reset_rate_limits"));
  expect(posts.map(call => JSON.parse(call.body!))).toEqual([
    { program: "cedar_ember", grant_id: "test_grant", request_id: operation.redeem_request_id },
    { program: "cedar_ember", grant_id: "test_grant", request_id: operation.redeem_request_id },
  ]);
  expect(posts.map(call => call.headers.get("authorization"))).toEqual(["Bearer a-access", "Bearer a-new"]);
  // Fresh usage is authoritative even after a partial reset; other limits still apply.
  f.options.status.cedar_ember.at_limit = false;
  f.options.onConsume = () => Response.json({ result: "reset" });
  await f.accounts.usage("a");
  expect(f.calls.at(-1)!.url.search).toBe("");
});

test("ambiguous Claude claims retain the operation and block another reset", async () => {
  const f = await setup();
  await f.accounts.usage("a");
  f.accounts.limited("a", new Headers({ "retry-after": "3600" }));
  const operation = input();
  f.options.onConsume = () => new Response("secret upstream details", { status: 503 });
  const failed = await f.consume(operation);
  expect(failed.status).toBe(503);
  expect(await failed.text()).not.toContain("secret upstream details");
  expect((await f.consume(input())).status).toBe(409);
  // A retry must reach the upstream with the original UUID even if listing changed.
  f.options.status.cedar_ember.grants[0]!.usable_now = false;
  f.options.onConsume = () => Response.json({ result: "already_used" });
  expect(await (await f.consume(operation)).json()).toMatchObject({ code: "already_used" });
  const posts = f.calls.filter(call => call.url.pathname.endsWith("/reset_rate_limits"));
  expect(posts).toHaveLength(2);
  expect(posts[0]!.body).toBe(posts[1]!.body);
  await f.accounts.usage("a");
  expect(f.calls.at(-1)!.url.search).toBe("");
});

test("weekly reset sends only its program and never spends it while listing", async () => {
  const f = await setup();
  await f.accounts.resets.list("a");
  expect(f.calls.some(call => call.body)).toBe(false);
  await f.consume({ ...input(), credit_id: "juniper_tide" });
  expect(JSON.parse(f.calls.at(-1)!.body!)).toEqual({ program: "juniper_tide" });
  expect(await f.accounts.choose("test-model")).toBe("a");
});
