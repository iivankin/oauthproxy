import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountStore } from "../src/store.ts";
import { Accounts } from "../src/accounts.ts";
import { Transport, type Fetch } from "../src/transport.ts";
import { HistoryStore } from "../src/history-store.ts";
import { handler } from "../src/proxy.ts";
import { serve } from "../src/server.ts";
import { accountSchema, tokensSchema, usageSchema, type Message } from "../src/schema.ts";
import { exhaustedQuota, hasQuota } from "../src/quota.ts";
import { createLogin, validateCode } from "../src/oauth.ts";
import { createHash } from "node:crypto";
import { fingerprint, IDENTITY } from "../src/profile.ts";

const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });

const quota = (used = 10) => ({ five_hour: { utilization: used, resets_at: null }, seven_day: { utilization: 20, resets_at: null } });
const quotaHeaders = { "anthropic-ratelimit-unified-status": "rejected",
  "anthropic-ratelimit-unified-representative-claim": "five_hour", "retry-after": "123", "request-id": "req_quota" };
const input: Message = { model: "claude-haiku-4-5-20251001", max_tokens: 32, messages: [{ role: "user", content: "Hello" }] };
const makeRequest = (body: unknown = input, headers: Record<string, string> = {}) => new Request("http://localhost/v1/messages", {
  method: "POST", headers: { "content-type": "application/json", "x-claude-code-session-id": crypto.randomUUID(), ...headers }, body: JSON.stringify(body),
});

async function setup(fetcher: Fetch, ids = ["a", "b"]) {
  const directory = await mkdtemp(join(tmpdir(), "claude-proxy-test-"));
  directories.push(directory);
  const store = new AccountStore(join(directory, "accounts.json"));
  await store.update(data => { data.accounts = ids.map(id => accountSchema.parse({
    id, email: `${id}@test.invalid`, name: id, organizationId: "org", accessToken: id,
    accountUuid: crypto.randomUUID(), deviceId: "a".repeat(64),
    refreshToken: `${id}-refresh`, expiresAt: Date.now() + 3_600_000,
  })); });
  return new Accounts(store, new Transport(fetcher, "https://mock.invalid", "https://mock.invalid/token", new HistoryStore(join(directory, "cas"))));
}

function controlPlane(url: string | URL, init?: RequestInit) {
  const path = new URL(url).pathname;
  if (path === "/api/oauth/usage") return Response.json(quota());
  if (path === "/v1/models") return Response.json({ data: [{ id: input.model, type: "model" }], has_more: false });
  return undefined;
}

describe("account routing and quota", () => {
  test("excludes exhausted account and preserves custom tools, system and beta flags", async () => {
    let forwarded: Record<string, unknown> | undefined;
    let headers: Headers | undefined;
    const accounts = await setup(async (url, init) => {
      const auth = new Headers(init?.headers).get("authorization");
      if (new URL(url).pathname === "/api/oauth/usage") return Response.json(quota(auth === "Bearer a" ? 100 : 20));
      const control = controlPlane(url, init);
      if (control) return control;
      headers = new Headers(init?.headers);
      forwarded = JSON.parse(String(init?.body));
      return Response.json({ id: "msg_test", content: [{ type: "text", text: "OK" }] });
    });
    const tools = [{ name: "echo", input_schema: { type: "object", properties: { value: { type: "string" } } } }];
    const response = await handler(accounts)(makeRequest({ ...input, system: "Custom instructions", tools, betas: ["test-beta"] },
      { authorization: "Bearer DO_NOT_FORWARD", "x-api-key": "DO_NOT_FORWARD" }));
    expect(response.status).toBe(200);
    expect(headers?.get("authorization")).toBe("Bearer b");
    expect(headers?.has("x-api-key")).toBe(false);
    expect(headers?.get("anthropic-beta")).toContain("test-beta");
    expect(forwarded?.tools).toEqual(tools);
    expect(forwarded?.messages).toEqual([{ role: "user", content: [{ type: "text", text: "Hello", cache_control: { type: "ephemeral", ttl: "1h" } }] }]);
    expect(forwarded?.betas).toBeUndefined();
    expect(forwarded?.system).toEqual([expect.objectContaining({ text: expect.stringContaining("cc_entrypoint=sdk-ts;") }),
      { type: "text", text: IDENTITY, cache_control: { type: "ephemeral", ttl: "1h" } },
      { type: "text", text: "Custom instructions", cache_control: { type: "ephemeral", ttl: "1h" } }]);
    expect(headers?.get("x-stainless-package-version")).toBe("0.112.1");
    expect(headers?.get("user-agent")).toContain("sdk-ts, agent-sdk/0.3.280");
    expect(headers?.get("x-app")).toBe("cli");
    expect(headers?.get("x-claude-code-request-class")).toBe("main");
    expect(headers?.get("x-client-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.headers.get("x-claude-code-session-id")).toBeTruthy();
  });

  test("unknown quota fails closed and per-model exhaustion is respected", async () => {
    expect(hasQuota(usageSchema.parse({ ...quota(), seven_day_opus: { utilization: 100, resets_at: null } }), "claude-opus-5")).toBe(false);
    expect(hasQuota(usageSchema.parse({ ...quota(), five_hour: null }))).toBe(false);
    expect(hasQuota(usageSchema.parse({ ...quota(), five_hour: { utilization: null, resets_at: null } }))).toBe(false);
    expect(hasQuota(usageSchema.parse({ ...quota(), seven_day_overage_included: { utilization: 100, resets_at: null } }), "claude-fable-5")).toBe(false);
    const accounts = await setup(async () => Response.json({ error: "unavailable" }, { status: 503 }));
    expect((await handler(accounts)(makeRequest())).status).toBe(503);
  });

  test("confirmed quota retries each account at most once, then cools down", async () => {
    const attempts: string[] = [];
    const accounts = await setup(async (url, init) => {
      const control = controlPlane(url, init);
      if (control) return control;
      attempts.push(new Headers(init?.headers).get("authorization")!);
      return Response.json({ error: { type: "rate_limit_error" } }, { status: 429, headers: quotaHeaders });
    });
    expect((await handler(accounts)(makeRequest())).status).toBe(429);
    expect(new Set(attempts).size).toBe(2);
    expect(attempts.length).toBe(2);
    expect((await handler(accounts)(makeRequest())).status).toBe(429);
    expect(attempts.length).toBe(2);
  });

  test("non-quota HTTP errors pass through verbatim without retry or cooldown", async () => {
    for (const status of [400, 403, 408, 409, 429, 500, 503, 529]) {
      let attempts = 0;
      const body = status === 503 ? "<html>maintenance</html>" : '{ "type": "error", "error": {"type":"rate_limit_error","message":"keep me","details":{"test":true}} }';
      const headers = { "content-type": status === 503 ? "text/html" : "application/json",
        "x-should-retry": "true", "retry-after-ms": "3210", "request-id": "req_original", "retry-after": "123" };
      const accounts = await setup(async (url, init) => {
        const control = controlPlane(url, init);
        if (control) return control;
        attempts++;
        return new Response(body, { status, headers });
      });
      const response = await handler(accounts)(makeRequest());
      expect(response.status).toBe(status);
      expect(await response.text()).toBe(body);
      for (const [name, value] of Object.entries(headers)) expect(response.headers.get(name)).toBe(value);
      expect(attempts).toBe(1);
      expect(await accounts.choose(input.model, new Set(["a"]))).toBe("b");
      expect(await accounts.choose(input.model, new Set(["b"]))).toBe("a");
    }
  });

  test("x-should-retry false prevents quota rotation and 401 refresh", async () => {
    for (const status of [401, 429]) {
      let attempts = 0;
      const body = '{"type":"error","error":{"type":"rate_limit_error","message":"original"}}';
      const accounts = await setup(async (url, init) => {
        const control = controlPlane(url, init);
        if (control) return control;
        attempts++;
        return new Response(body, { status, headers: { ...quotaHeaders, "x-should-retry": "false" } });
      });
      const response = await handler(accounts)(makeRequest());
      expect(response.status).toBe(status);
      expect(await response.text()).toBe(body);
      expect(response.headers.get("x-should-retry")).toBe("false");
      expect(attempts).toBe(1);
    }
  });

  test("failed alternative selection preserves the original quota response", async () => {
    let attempts = 0;
    const body = '{"type":"error","error":{"type":"rate_limit_error","message":"quota"}}';
    const accounts = await setup(async (url, init) => {
      if (new URL(url).pathname === "/api/oauth/usage")
        return Response.json(quota(new Headers(init?.headers).get("authorization") === "Bearer b" ? 100 : 10));
      const control = controlPlane(url, init);
      if (control) return control;
      attempts++;
      return new Response(body, { status: 429, headers: quotaHeaders });
    });
    const response = await handler(accounts)(makeRequest());
    expect(response.status).toBe(429);
    expect(await response.text()).toBe(body);
    expect(response.headers.get("retry-after")).toBe("123");
    expect(response.headers.get("request-id")).toBe("req_quota");
    expect(attempts).toBe(1);
  });

  test("quota recognition excludes ambiguous and overage-only errors; model cooldown stays scoped", async () => {
    const classify = (headers: Record<string, string>) => exhaustedQuota(new Response(null, { status: 429, headers }));
    expect(classify({ "retry-after": "5000" })).toBeUndefined();
    expect(classify({ "anthropic-ratelimit-unified-overage-disabled-reason": "out_of_credits" })).toBeUndefined();
    expect(classify({ ...quotaHeaders, "anthropic-ratelimit-unified-overage-status": "allowed" })).toBeUndefined();
    expect(classify({ ...quotaHeaders, "anthropic-ratelimit-unified-representative-claim": "overage" })).toBeUndefined();
    expect(classify({ "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-7d-status": "rejected" })).toBe("account");
    const headers = { ...quotaHeaders, "anthropic-ratelimit-unified-representative-claim": "seven_day_overage_included",
      "anthropic-ratelimit-unified-7d-status": "allowed_warning", "anthropic-ratelimit-unified-7d_oi-status": "rejected" };
    expect(classify(headers)).toBe("model");
    const accounts = await setup(async (url, init) => new URL(url).pathname === "/v1/models"
      ? Response.json({ data: [{ id: input.model }, { id: "claude-fable-5" }], has_more: false })
      : controlPlane(url, init)!, ["a"]);
    expect(await accounts.choose("claude-fable-5")).toBe("a");
    accounts.limited("a", new Headers(headers), "claude-fable-5");
    expect(await accounts.choose(input.model)).toBe("a");
    await expect(accounts.choose("claude-fable-5")).rejects.toThrow("No account has quota");
  });

  test("confirmed quota switches accounts and can return a successful stream", async () => {
    const attempts: string[] = [];
    const wire = 'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"busy"}}\n\n';
    const accounts = await setup(async (url, init) => {
      const control = controlPlane(url, init);
      if (control) return control;
      attempts.push(new Headers(init?.headers).get("authorization")!);
      return attempts.length === 1
        ? Response.json({ type: "error", error: { type: "rate_limit_error", message: "quota" } }, { status: 429, headers: quotaHeaders })
        : new Response(wire, { headers: { "content-type": "text/event-stream", "request-id": "req_stream" } });
    });
    const response = await handler(accounts)(makeRequest({ ...input, stream: true }));
    expect(response.status).toBe(200);
    expect(response.headers.get("request-id")).toBe("req_stream");
    expect(await response.text()).toBe(wire);
    expect(attempts.length).toBe(2);
    expect(new Set(attempts).size).toBe(2);
  });

  test("refusal fields and fallback headers pass through without another generation", async () => {
    let attempts = 0;
    const body = { id: "msg_refusal", type: "message", role: "assistant", content: [], stop_reason: "refusal",
      stop_details: { category: "test", explanation: null }, credit_token: "opaque" };
    const headers = { "x-is-refusal-fallback": "true", "x-cc-fallback-latched-by": "req_first",
      "x-cc-fallback-from-model": "original-model", "x-cc-fallback-category": "test", "x-cc-fallback-trigger": "refusal",
      "x-cc-original-request-id": "req_original", "request-id": "req_refusal" };
    const accounts = await setup(async (url, init) => {
      const control = controlPlane(url, init);
      if (control) return control;
      attempts++;
      return Response.json(body, { headers });
    });
    const response = await handler(accounts)(makeRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(body);
    for (const [name, value] of Object.entries(headers)) expect(response.headers.get(name)).toBe(value);
    expect(attempts).toBe(1);
  });

  test("random selection can choose either available account", async () => {
    const accounts = await setup(async (url, init) => controlPlane(url, init)!);
    const selected = new Set(await Promise.all(Array.from({ length: 100 }, () => accounts.choose(input.model))));
    expect([...selected].sort()).toEqual(["a", "b"]);
  });
});

describe("credentials", () => {
  test("relogin preserves device identity and stores the real profile account UUID", async () => {
    const uuid = crypto.randomUUID();
    const accounts = await setup(async () => Response.json({ account: { uuid, email: "test@example.invalid" }, organization: { uuid: "org" } }), []);
    const tokens = tokensSchema.parse({ accessToken: "first", expiresAt: Date.now() + 3_600_000 });
    const first = await accounts.add(tokens);
    const identity = (await accounts.store.read()).accounts[0]!.deviceId;
    const restarted = new Accounts(new AccountStore(accounts.store.path), accounts.transport);
    await restarted.add({ ...tokens, accessToken: "second" });
    const stored = await accounts.store.read();
    expect(stored.version).toBe(2);
    expect(stored.accounts.length).toBe(1);
    expect(stored.accounts[0]!.id).toBe(first.id);
    expect(stored.accounts[0]!.accountUuid).toBe(uuid);
    expect(stored.accounts[0]!.deviceId).toBe(identity);
    expect(stored.accounts[0]!.accessToken).toBe("second");
  });

  test("concurrent refresh across managers rotates exactly once and persists private JSON", async () => {
    let refreshes = 0;
    const accounts = await setup(async () => {
      refreshes++;
      await Bun.sleep(30);
      return Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 });
    }, ["a"]);
    await accounts.store.update(data => { data.accounts[0]!.expiresAt = 1; });
    const other = new Accounts(new AccountStore(accounts.store.path), accounts.transport);
    const result = await Promise.all([accounts.token("a"), other.token("a"), accounts.token("a")]);
    expect(refreshes).toBe(1);
    expect(result.every(account => account.accessToken === "new-access")).toBe(true);
    expect((await accounts.store.read()).accounts[0]!.refreshToken).toBe("new-refresh");
    expect((await stat(accounts.store.path)).mode & 0o777).toBe(0o600);
  });

  test("401 refreshes even an unexpired token; invalid grant disables account", async () => {
    let refreshes = 0;
    const accounts = await setup(async (url, init) => {
      if (new URL(url).pathname === "/token") {
        refreshes++;
        return Response.json({ access_token: "new", refresh_token: "rotated", expires_in: 3600 });
      }
      return new Headers(init?.headers).get("authorization") === "Bearer new" ? Response.json(quota()) : new Response(null, { status: 401 });
    }, ["a"]);
    expect((await accounts.usage("a")).five_hour?.utilization).toBe(10);
    expect(refreshes).toBe(1);
    const broken = new Accounts(accounts.store, new Transport(async () => Response.json({ error: "invalid_grant" }, { status: 400 })));
    await expect(broken.token("a", "new")).rejects.toThrow("invalid_grant");
    expect((await accounts.store.read()).accounts[0]!.disabled).toBe(true);
  });
});

test("OAuth uses PKCE S256 and rejects missing/mismatched state", () => {
  const login = createLogin("http://localhost:54545/callback");
  const url = new URL(login.url);
  expect(url.searchParams.get("code_challenge")).toBe(createHash("sha256").update(login.verifier).digest("base64url"));
  expect(url.searchParams.get("response_type")).toBe("code");
  expect(validateCode(`secret#${login.state}`, null, login.state)).toBe("secret");
  expect(validateCode("secret", login.state, login.state)).toBe("secret");
  expect(() => validateCode("secret", "wrong", login.state)).toThrow("state");
  expect(() => validateCode("secret", null, login.state)).toThrow("state");
});

test("billing fingerprint matches capture and previous request stays within account/session", async () => {
  expect(fingerprint({ ...input, messages: [{ role: "user", content: "Perform the verification job now." }] })).toBe("80f");
  const billings: string[] = [];
  const diagnostics: unknown[] = [];
  let sequence = 0;
  const accounts = await setup(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    billings.push(body.system[0].text);
    diagnostics.push(body.diagnostics);
    sequence++;
    return Response.json({ id: `msg_${sequence}`, content: [{ type: "text", text: "OK" }] }, { headers: { "request-id": `req_${sequence}` } });
  });
  const session = crypto.randomUUID();
  const continued: Message = { ...input, messages: [...input.messages, { role: "assistant", content: "OK" }, { role: "user", content: "Next" }] };
  const send = (id: string, sessionId: string, body = input) => accounts.message(id, body, sessionId, crypto.randomUUID(), [], new AbortController().signal);
  await send("a", session);
  await send("a", session, continued);
  await send("b", session, continued);
  await send("a", crypto.randomUUID(), continued);
  expect(billings[0]).not.toContain("cc_prev_req");
  expect(billings[1]).toContain("cc_prev_req=req_1;");
  expect(billings[2]).not.toContain("cc_prev_req");
  expect(billings[3]).not.toContain("cc_prev_req");
  expect(diagnostics).toEqual([{ previous_message_id: null }, { previous_message_id: "msg_1" }, { previous_message_id: null }, { previous_message_id: null }]);
});

test("model pagination loads later pages before selecting an account", async () => {
  const accounts = await setup(async url => {
    const parsed = new URL(url);
    if (parsed.pathname === "/api/oauth/usage") return Response.json(quota());
    return parsed.searchParams.has("after_id")
      ? Response.json({ data: [{ id: input.model }], has_more: false })
      : Response.json({ data: [{ id: "another-model" }], has_more: true, last_id: "another-model" });
  }, ["a"]);
  expect(await accounts.choose(input.model)).toBe("a");
  expect((await accounts.models("a")).length).toBe(2);
});

test("ambiguous network failures are not retried by SDK or proxy", async () => {
  let attempts = 0;
  const accounts = await setup(async (url, init) => {
    const control = controlPlane(url, init);
    if (control) return control;
    attempts++;
    throw new Error("connection lost after request sent");
  });
  expect((await handler(accounts)(makeRequest())).status).toBe(502);
  expect(attempts).toBe(1);
});

test("local auth protects all routes and non-loopback binding needs a key", async () => {
  const accounts = await setup(async () => { throw new Error("must not contact upstream"); });
  expect((await handler(accounts, "local-secret")(makeRequest())).status).toBe(401);
  expect((await handler(accounts)(makeRequest(input, { origin: "https://evil.invalid" }))).status).toBe(403);
  expect(() => serve(accounts, "0.0.0.0", 0)).toThrow("PROXY_API_KEY");
});

test("SSE forwards the first chunk without buffering and propagates abort", async () => {
  let upstreamSignal: AbortSignal | null | undefined;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const accounts = await setup(async (url, init) => {
    const control = controlPlane(url, init);
    if (control) return control;
    upstreamSignal = init?.signal;
    return new Response(new ReadableStream<Uint8Array>({ start(c) { controller = c; c.enqueue(new TextEncoder().encode("event: ping\ndata: {}\n\n")); } }),
      { headers: { "content-type": "text/event-stream", "content-encoding": "gzip" } });
  }, ["a"]);
  const abort = new AbortController();
  const response = await handler(accounts)(new Request(makeRequest({ ...input, stream: true }), { signal: abort.signal }));
  expect(response.headers.has("content-encoding")).toBe(false);
  const reader = response.body!.getReader();
  const chunk = await reader.read();
  expect(new TextDecoder().decode(chunk.value)).toContain("event: ping");
  abort.abort();
  expect(upstreamSignal?.aborted).toBe(true);
  controller!.close();
  await reader.cancel();
});

test("missing session header warns, returns a new UUID and does not warn when it is reused", async () => {
  const accounts = await setup(async (url, init) => controlPlane(url, init) ?? Response.json({ id: "msg_test", content: [] }), ["a"]);
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const request = makeRequest();
    request.headers.delete("x-claude-code-session-id");
    const response = await handler(accounts)(request);
    expect(response.status).toBe(200);
    const session = response.headers.get("x-claude-code-session-id")!;
    expect(session).toMatch(/^[0-9a-f-]{36}$/);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("Missing x-claude-code-session-id");
    await handler(accounts)(makeRequest(input, { "x-claude-code-session-id": session }));
    expect(warn).toHaveBeenCalledTimes(1);
  } finally { warn.mockRestore(); }
});
