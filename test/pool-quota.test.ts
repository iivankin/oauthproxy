import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Accounts } from "../src/accounts.ts";
import { AccountStore } from "../src/store.ts";
import { Transport, type Fetch } from "../src/transport.ts";
import { accountSchema, usageSchema } from "../src/schema.ts";
import { handler } from "../src/proxy.ts";
import { quotaReset, responseQuotaReset } from "../src/quota.ts";

const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
const model = "claude-sonnet-5";
const now = Math.floor(Date.now() / 1000) * 1000;
const hour = 3_600_000;
const window = (utilization: number | null, offset: number) => ({ utilization, resets_at: new Date(now + offset).toISOString() });
const usage = () => usageSchema.parse({ five_hour: window(10, hour), seven_day: window(20, 24 * hour) });
const request = (native = false) => new Request("http://localhost/v1/messages", { method: "POST", headers: {
  "content-type": "application/json", "x-claude-code-session-id": crypto.randomUUID(),
  ...(native && { "user-agent": "claude-cli/2.1.306" }),
}, body: JSON.stringify({ model, max_tokens: 10, messages: [{ role: "user", content: "Hi" }] }) });

async function setup(fetcher: Fetch, ids = ["a", "b"]) {
  const directory = await mkdtemp(join(tmpdir(), "pool-quota-"));
  directories.push(directory);
  const store = new AccountStore(join(directory, "accounts.json"));
  await store.update(data => { data.accounts = ids.map(id => accountSchema.parse({ id, name: id, email: `${id}@test.invalid`,
    organizationId: "org", accountUuid: crypto.randomUUID(), deviceId: "a".repeat(64),
    accessToken: id, expiresAt: Date.now() + 24 * hour,
  })); });
  return new Accounts(store, new Transport(fetcher, "https://mock.invalid"));
}

test("reset uses the last blocking window, requested model and usage-limit mode", () => {
  const limits = usageSchema.parse({ ...usage(), five_hour: window(100, hour), seven_day: window(100, 6 * hour),
    seven_day_opus: window(100, 8 * hour), seven_day_sonnet: window(100, 7 * hour),
    seven_day_overage_included: window(100, 9 * hour) });
  expect(quotaReset(limits, "claude-haiku-5", undefined, now)).toEqual({ at: now + 6 * hour, claim: "seven_day" });
  for (const [name, hours, claim] of [["opus", 8, "seven_day_opus"], ["sonnet", 7, "seven_day_sonnet"],
    ["fable", 9, "seven_day_overage_included"]] as const)
    expect(quotaReset(limits, `claude-${name}-5`, undefined, now)).toEqual({ at: now + hours * hour, claim });
  expect(quotaReset({ ...usage(), five_hour: window(100, hour) }, model, "slow", now)).toBeUndefined();
  expect(quotaReset(limits, model, "extended", now)).toBeUndefined();
  expect(quotaReset({ ...limits, five_hour: { utilization: 100, resets_at: null } }, model, undefined, now)).toBeUndefined();
  expect(quotaReset({ ...limits, seven_day: { ...window(100, hour), locked_reason: "policy" } }, model, undefined, now)).toBeUndefined();
  expect(quotaReset({ ...limits, five_hour: window(null, hour) }, model, undefined, now)).toBeUndefined();
  expect(responseQuotaReset(new Headers({ "retry-after": "123" }), now)).toBeUndefined();
});

test("local pool rejection advertises min(account max resets), excluding disabled and unsupported models", async () => {
  let sends = 0;
  const accounts = await setup(async (url, init) => {
    const id = new Headers(init?.headers).get("authorization")?.slice(7);
    if (new URL(url).pathname === "/api/oauth/usage") return Response.json({ ...usage(),
      five_hour: window(100, id === "b" ? 2 * hour : hour),
      seven_day: window(id === "a" ? 100 : 20, 10 * hour) });
    if (new URL(url).pathname === "/v1/models") return Response.json({ data: [{ id: id === "c" ? "other-model" : model }] });
    sends++; return new Response("unexpected");
  }, ["a", "b", "c", "d"]);
  await accounts.store.update(data => { data.accounts.find(item => item.id === "d")!.disabled = true; });
  const response = await handler(accounts)(request());
  expect(response.status).toBe(429);
  expect(response.headers.get("anthropic-ratelimit-unified-status")).toBe("rejected");
  expect(response.headers.get("anthropic-ratelimit-unified-reset")).toBe(String((now + 2 * hour) / 1000));
  expect(response.headers.get("anthropic-ratelimit-unified-representative-claim")).toBe("five_hour");
  expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(7100);
  expect(Number(response.headers.get("retry-after"))).toBeLessThanOrEqual(7200);
  expect(sends).toBe(0);
});

test("terminal upstream quota errors retain encoded body and diagnostics but use the pool's reset", async () => {
  for (const native of [false, true]) {
    let sends = 0, reads = 0;
    const original = '{ "type":"error", "error":{"type":"rate_limit_error","message":"quota"}}';
    const body = native ? Bun.gzipSync(original) : new TextEncoder().encode(original);
    const accounts = await setup(async (url, init) => {
      const id = new Headers(init?.headers).get("authorization")?.slice(7);
      if (new URL(url).pathname === "/api/oauth/usage") { reads++; return Response.json(usage()); }
      if (new URL(url).pathname === "/v1/models") return Response.json({ data: [{ id: model }] });
      sends++;
      return new Response(body, { status: 429, headers: {
        "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-representative-claim": "five_hour",
        "anthropic-ratelimit-unified-reset": String((now + (id === "a" ? hour : 2 * hour)) / 1000),
        "retry-after": "123", "retry-after-ms": "123000", "request-id": "req_original", "x-custom": "keep",
        ...(native && { "content-encoding": "gzip", "content-length": String(body.length) }),
      } });
    });
    const response = await handler(accounts)(request(native));
    expect(response.status).toBe(429);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(body);
    expect(response.headers.get("anthropic-ratelimit-unified-reset")).toBe(String((now + hour) / 1000));
    expect(Number(response.headers.get("retry-after-ms"))).toBeGreaterThan(3_500_000);
    expect(response.headers.get("request-id")).toBe("req_original");
    expect(response.headers.get("x-custom")).toBe("keep");
    if (native) expect(response.headers.get("content-encoding")).toBe("gzip");
    expect(sends).toBe(2);
    const next = await handler(accounts)(request(native));
    expect(next.status).toBe(429);
    expect(next.headers.get("anthropic-ratelimit-unified-reset")).toBe(String((now + hour) / 1000));
    expect({ sends, reads }).toEqual({ sends: 2, reads: 2 });
  }
});

test("no synthetic pool reset when a reset is unknown or another account is available", async () => {
  const unknown = await setup(async url => new URL(url).pathname === "/api/oauth/usage"
    ? Response.json({ ...usage(), five_hour: { utilization: 100, resets_at: null } })
    : Response.json({ data: [{ id: model }] }));
  expect((await handler(unknown)(request())).headers.has("anthropic-ratelimit-unified-reset")).toBe(false);
  let sends = 0;
  const accounts = await setup(async url => {
    if (new URL(url).pathname === "/api/oauth/usage") return Response.json(usage());
    if (new URL(url).pathname === "/v1/models") return Response.json({ data: [{ id: model }] });
    sends++;
    return new Response("original", { status: 429, headers: {
      "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-representative-claim": "seven_day",
      "anthropic-ratelimit-unified-reset": String((now + 8 * hour) / 1000),
      "retry-after": "123", "x-should-retry": "false",
    } });
  });
  const response = await handler(accounts)(request());
  expect(await response.text()).toBe("original");
  expect(response.headers.get("retry-after")).toBe("123");
  expect(response.headers.get("x-should-retry")).toBe("false");
  expect(sends).toBe(1);
});

test("pool reset survives catalog expiry during account and model cooldowns, then refreshes after reset", async () => {
  for (const claim of ["five_hour", "seven_day_sonnet"]) {
    let reads = 0, sends = 0;
    let at = Date.now();
    const reset = Math.floor((at + 2 * hour) / 1000);
    const accounts = await setup(async url => {
      if (new URL(url).pathname === "/api/oauth/usage") { reads++; return Response.json(usage()); }
      if (new URL(url).pathname === "/v1/models") { reads++; return Response.json({ data: [{ id: model }] }); }
      sends++;
      return new Response("original", { status: 429, headers: {
        "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-representative-claim": claim,
        "anthropic-ratelimit-unified-reset": String(reset),
      } });
    });
    const clock = spyOn(Date, "now").mockImplementation(() => at);
    try {
      const handle = handler(accounts);
      expect((await handle(request())).headers.get("anthropic-ratelimit-unified-reset")).toBe(String(reset));
      at += 6 * 60_000;
      const response = await handle(request());
      expect(response.status).toBe(429);
      expect(response.headers.get("anthropic-ratelimit-unified-reset")).toBe(String(reset));
      expect({ reads, sends }).toEqual({ reads: 4, sends: 2 });
      // An expired rejection/catalog must not manufacture a future reset.
      at = (reset + 1) * 1000;
      expect(await accounts.poolQuotaReset(model)).toBeUndefined();
      expect(await accounts.choose(model)).toBeTruthy();
      expect(reads).toBe(8);
    } finally { clock.mockRestore(); }
  }
});
