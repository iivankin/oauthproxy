import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Accounts } from "../src/accounts.ts";
import { AccountStore } from "../src/store.ts";
import { Transport } from "../src/transport.ts";
import { HistoryStore } from "../src/history-store.ts";
import { accountSchema } from "../src/schema.ts";
import { handler } from "../src/proxy.ts";
import { isClaudeCode } from "../src/claude-request.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });
const ua = "claude-cli/2.1.303 (external, cli)";
const wire = ' {\n "model" : "native-model", "max_tokens": 3.2e1, "stream":true,\n'
  + '"system":[{"type":"text","text":"x-anthropic-billing-header: cc_version=2.1.303.abc; cch=12345;"}],'
  + '"metadata":{"user_id":"original-account-metadata"},"diagnostics":{"previous_message_id":"msg_original"},'
  + '"messages":[{"role":"future_role","content":[{"type":"future_block","signature":"opaque"}]}],'
  + '"future_field":{"unchanged":true} }\n';
const events = ': native comment\r\nevent: future_event\r\ndata: {"unknown":true}\r\n\r\n'
  + 'event: error\r\ndata: {"type":"error","error":{"type":"future_error"}}\r\n\r\n';

async function setup(ids = ["a"]) {
  const directory = await mkdtemp(join(tmpdir(), "claude-native-test-"));
  const calls: { url: URL; headers: Headers; body: Uint8Array }[] = [];
  let reply = () => new Response(events, { headers: { "content-type": "text/event-stream", "request-id": "req_native" } });
  let refreshes = 0;
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/oauth/usage") return Response.json({
      five_hour: { utilization: 0, resets_at: null }, seven_day: { utilization: 0, resets_at: null },
    });
    if (url.pathname === "/v1/models") return Response.json({ data: [{ id: "native-model" }], has_more: false });
    if (url.pathname === "/token") {
      refreshes++;
      return Response.json({ access_token: "refreshed", expires_in: 3600 });
    }
    calls.push({ url, headers: request.headers, body: new Uint8Array(await request.arrayBuffer()) });
    return reply();
  } });
  const store = new AccountStore(join(directory, "accounts.json"));
  await store.update(data => { data.accounts = ids.map(id => accountSchema.parse({ id,
    email: `${id}@test.invalid`, name: id, organizationId: "org", accountUuid: crypto.randomUUID(),
    deviceId: "a".repeat(64), accessToken: id, refreshToken: `${id}-refresh`, expiresAt: Date.now() + 3600000,
  })); });
  const accounts = new Accounts(store, new Transport(fetch, upstream.url.origin, `${upstream.url.origin}/token`, new HistoryStore(join(directory, "cas"))));
  const run = handler(accounts, "proxy-key");
  cleanups.push(async () => { await upstream.stop(true); await rm(directory, { recursive: true, force: true }); });
  return { calls, accounts, run, refreshes: () => refreshes,
    setReply(value: () => Response) { reply = value; },
    request(body: string | Uint8Array<ArrayBuffer> = wire, headers: Record<string, string> = {}) {
      return new Request("http://proxy.invalid/v1/messages?beta=true&client=a%2Fb", { method: "POST", body,
        headers: { "user-agent": ua, authorization: "Bearer proxy-key", "content-type": "application/json",
          "x-claude-code-session-id": "native-session", ...headers } });
    },
  };
}

test("only native Claude Code uses passthrough; Agent SDK user agents stay on the SDK path", () => {
  for (const agent of [ua, "claude-cli/2.1.303 (external, unknown)", "claude-cli/2.1.303 (external, sdk-cli)"])
    expect(isClaudeCode(new Headers({ "user-agent": agent }))).toBe(true);
  for (const agent of ["", "anthropic-typescript/0.112.1", "other/1.0",
    "claude-cli/2.1.303 (external, sdk-ts)", "claude-cli/2.1.303 (external, sdk-py)",
    "claude-cli/2.1.303 (external, cli, agent-sdk/0.3.303)"])
    expect(isClaudeCode(new Headers({ "user-agent": agent }))).toBe(false);
});

test("native JSON, query, billing, metadata, CCH and application headers pass unchanged", async () => {
  const f = await setup();
  const original = { "anthropic-beta": "client-beta,client-beta", "anthropic-version": "2023-06-01",
    "x-app": "cli", "x-stainless-package-version": "native-sdk", "x-claude-code-request-class": "auxiliary",
    "x-claude-code-agent-id": "agent", "x-claude-code-parent-agent-id": "parent",
    "x-claude-code-prompt-id": "opaque-prompt", "x-client-request-id": "original-request", "anthropic-usage-limit": "future-mode" };
  const response = await f.run(f.request(wire, { ...original, "x-api-key": "proxy-key", host: "wrong.invalid",
    connection: "keep-alive, x-private-hop", "x-private-hop": "remove" }));
  expect(response.status).toBe(200);
  expect(await response.text()).toBe(events);
  expect(response.headers.get("request-id")).toBe("req_native");
  expect(f.calls).toHaveLength(1);
  const sent = f.calls[0]!;
  expect(new TextDecoder().decode(sent.body)).toBe(wire);
  expect(sent.url.search).toBe("?beta=true&client=a%2Fb");
  expect(sent.headers.get("authorization")).toBe("Bearer a");
  expect(sent.headers.get("x-api-key")).toBeNull();
  expect(sent.headers.get("host")).not.toBe("wrong.invalid");
  expect(sent.headers.get("x-private-hop")).toBeNull();
  expect(sent.headers.get("user-agent")).toBe(ua);
  for (const [key, value] of Object.entries(original)) expect(sent.headers.get(key)).toBe(value);
});

test("gzip request and response bytes survive the real Bun fetch path", async () => {
  const f = await setup();
  const request = new Uint8Array(Bun.gzipSync(wire));
  const reply = new Uint8Array(Bun.gzipSync(events));
  f.setReply(() => new Response(reply, { headers: { "content-encoding": "gzip", "content-type": "text/event-stream" } }));
  const response = await f.run(f.request(request, { "content-encoding": "gzip", "accept-encoding": "gzip" }));
  expect(response.status).toBe(200);
  expect(f.calls[0]!.body).toEqual(request);
  expect(f.calls[0]!.headers.get("content-encoding")).toBe("gzip");
  expect(response.headers.get("content-encoding")).toBe("gzip");
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(reply);
});

test("Agent SDK requests still get SDK preparation rather than native forwarding", async () => {
  const f = await setup();
  f.setReply(() => Response.json({ id: "msg_sdk", content: [{ type: "text", text: "OK" }] }));
  const response = await f.run(f.request(JSON.stringify({ model: "native-model", max_tokens: 32,
    messages: [{ role: "user", content: "hi" }] }), { "user-agent": "claude-cli/2.1.303 (external, sdk-ts, agent-sdk/0.3.303)" }));
  expect(response.status).toBe(200);
  const sent = f.calls[0]!;
  expect(sent.headers.get("user-agent")).toContain("agent-sdk/0.3.285");
  expect(sent.headers.get("anthropic-beta")).toContain("oauth-2025-04-20");
  expect(JSON.parse(new TextDecoder().decode(sent.body)).system[0].text).toContain("cc_entrypoint=sdk-ts;");
});

test("native 401 refresh repeats identical bytes; ordinary errors retain upstream body and headers", async () => {
  const f = await setup();
  const error = ' {"type":"error", "error":{"type":"rate_limit_error","message":"ordinary"}}\n';
  f.setReply(() => new Response(error, { status: f.calls.length === 1 ? 401 : 429,
    headers: { "retry-after": "17", "request-id": "req_ordinary" } }));
  const response = await f.run(f.request());
  expect(response.status).toBe(429);
  expect(await response.text()).toBe(error);
  expect(response.headers.get("retry-after")).toBe("17");
  expect(response.headers.get("request-id")).toBe("req_ordinary");
  expect(f.refreshes()).toBe(1);
  expect(f.calls.map(call => new TextDecoder().decode(call.body))).toEqual([wire, wire]);
  expect(f.calls.map(call => call.headers.get("authorization"))).toEqual(["Bearer a", "Bearer refreshed"]);
});

test("confirmed native quota failover preserves the complete request while changing only credentials", async () => {
  const f = await setup(["a", "b"]);
  f.setReply(() => f.calls.length === 1 ? new Response("quota", { status: 429, headers: {
    "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-representative-claim": "five_hour",
  } }) : new Response(events));
  const response = await f.run(f.request());
  expect(response.status).toBe(200);
  expect(await response.text()).toBe(events);
  expect(f.calls).toHaveLength(2);
  expect(f.calls[0]!.body).toEqual(f.calls[1]!.body);
  expect(f.calls[0]!.headers.get("authorization")).not.toBe(f.calls[1]!.headers.get("authorization"));
  expect(f.calls[0]!.headers.get("user-agent")).toBe(f.calls[1]!.headers.get("user-agent"));
  expect(await f.accounts.choose("native-model", new Set(), { sessionId: "native-session" })).toBe(
    f.calls[1]!.headers.get("authorization")!.slice("Bearer ".length));
});
