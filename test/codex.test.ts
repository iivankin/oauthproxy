import { afterEach, expect, test } from "bun:test";
import { once } from "node:events";
import { readFile, stat } from "node:fs/promises";
import { WebSocket } from "ws";
import { Accounts, usageAllowed } from "../src/codex/accounts.ts";
import { deviceLogin } from "../src/codex/oauth.ts";
import { NativeRelay } from "../src/codex/relay.ts";
import { fixture, openSocket } from "./codex-fixture.ts";

const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
async function setup() { const f = await fixture(); fixtures.push(f); return f; }
afterEach(async () => { for (const f of fixtures.splice(0)) await f.close(); });

test("one server: Claude SSE, distinct provider catalogs, local auth and Origin rejection", async () => {
  const f = await setup();
  const headers = { authorization: "Bearer local-key" };
  expect((await fetch(`${f.url}health`)).status).toBe(401);
  expect((await fetch(`${f.url}codex/accounts`, { headers: { ...headers, origin: "https://bad.invalid" } })).status).toBe(403);
  const claude = await (await fetch(`${f.url}claude/v1/models`, { headers })).json();
  const codex = await (await fetch(`${f.url}codex/v1/models`, { headers })).json();
  expect(claude.data[0].id).toBe("claude-test");
  expect(codex.models[0].slug).toBe("test-model");
  expect((await fetch(`${f.url}v1/responses`, { headers })).status).toBe(426);
  const accounts = await (await fetch(`${f.url}codex/accounts`, { headers })).text();
  expect(accounts).not.toContain("accessToken");
  expect(accounts).not.toContain("refreshToken");
  const response = await fetch(`${f.url}v1/messages`, { method: "POST", headers: { ...headers, "content-type": "application/json", "x-claude-code-session-id": crypto.randomUUID() },
    body: JSON.stringify({ model: "claude-test", max_tokens: 16, messages: [{ role: "user", content: "hi" }], stream: true }) });
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("event: message_stop");
});

test("two turns and compaction pass byte-for-byte on one account/connection, with native headers", async () => {
  const f = await setup();
  f.usage.set("Bearer b-access", { rate_limit: { allowed: false, limit_reached: true } });
  const { socket, headers } = await openSocket(`${f.wsUrl}?model=test-model`, { "chatgpt-account-id": "DO-NOT-FORWARD", cookie: "private", "x-codex-turn-state": "stale" });
  expect(headers["x-codex-turn-state"]).toBe("sticky-server-value");
  expect(headers["x-request-id"]).toBe("req_test");
  expect(headers["session-id"]).toBe("test-session");
  expect(f.handshakes[0]?.authorization).toBe("Bearer a-access");
  expect(f.handshakes[0]?.["chatgpt-account-id"]).toBe("a");
  expect(f.handshakes[0]?.["openai-beta"]).toBe("responses_websockets=2026-02-06");
  expect(f.handshakes[0]?.["session-id"]).toBe("test-session");
  expect(f.handshakes[0]?.["thread-id"]).toBe("test-session");
  expect(f.handshakes[0]?.cookie).toBeUndefined();
  expect(f.handshakes[0]?.["x-codex-turn-state"]).toBeUndefined();
  const first = '{ "type": "response.create", "model":"test-model", "instructions":"CUSTOM ONLY", "input":[{"role":"user","content":"hello"}], "store":false }';
  const second = JSON.stringify({ type: "response.create", model: "test-model", previous_response_id: "resp_first",
    input: [{ type: "reasoning", encrypted_content: "opaque+/==" }, { role: "user", content: "next" }], context_management: [{ type: "compaction", compact_threshold: 1000 }] });
  for (const frame of [first, second]) {
    const reply = once(socket, "message");
    socket.send(frame);
    const [data, binary] = await reply;
    expect(data.toString()).toBe(frame);
    expect(binary).toBe(false);
  }
  expect(f.frames).toEqual([first, second]);
  expect(f.handshakes).toHaveLength(1);
  socket.close();
});

test("error/refusal/unknown event payloads including headers are not rewritten or retried", async () => {
  const f = await setup();
  const responses = [
    JSON.stringify({ type: "error", status: 429, error: { code: "usage_limit_reached" }, headers: { "retry-after": "999" }, future: 42 }),
    JSON.stringify({ type: "response.refusal.delta", delta: "No" }),
    JSON.stringify({ type: "response.failed", response: { error: { code: "rate_limit_exceeded" } } }),
    JSON.stringify({ type: "response.completed", response: { id: "resp_ok", output: [] } }),
  ];
  f.options.onFrame = socket => { socket.send(responses.shift()!); };
  const expected = [...responses];
  const { socket } = await openSocket(f.wsUrl);
  for (const frame of expected) {
    const reply = once(socket, "message");
    socket.send('{"type":"response.create"}');
    expect((await reply)[0].toString()).toBe(frame);
  }
  expect(f.handshakes).toHaveLength(1);
  expect(f.frames).toHaveLength(4);
  socket.close();
});

test("upstream HTTP handshake failure retains status, raw body and retry headers; no account hopping", async () => {
  const f = await setup();
  f.options.rejectStatus = 429;
  f.options.rejectBody = "raw upstream refusal\n";
  const result = await rejected(f.wsUrl);
  expect(result.status).toBe(429);
  expect(result.body).toBe(f.options.rejectBody);
  expect(result.headers["retry-after"]).toBe("7");
  expect(result.headers["x-request-id"]).toBe("req_fail");
  expect(f.handshakes).toHaveLength(1);
});

test("WebSocket auth and Origin checks happen before upstream connection", async () => {
  const f = await setup();
  expect((await rejected(f.wsUrl, { authorization: "Bearer wrong" })).status).toBe(401);
  expect((await rejected(f.wsUrl, { origin: "https://bad.invalid" })).status).toBe(403);
  expect(f.handshakes).toHaveLength(0);
});

test("close codes/reasons and binary payload survive forwarding; client close ends upstream", async () => {
  const f = await setup();
  const { socket } = await openSocket(f.wsUrl);
  const response = once(socket, "message");
  socket.send(Buffer.from([0, 1, 255]), { binary: true });
  const [data, binary] = await response;
  expect(Buffer.from(data)).toEqual(Buffer.from([0, 1, 255]));
  expect(binary).toBe(true);
  const upstream = [...f.upstreamSockets][0]!;
  const closed = once(socket, "close");
  upstream.close(1008, "policy test");
  const [code, reason] = await closed;
  expect(code).toBe(1008);
  expect(reason.toString()).toBe("policy test");
  const next = await openSocket(f.wsUrl);
  const upstreamClosed = once(f.events, "upstream-close");
  next.socket.close(1000, "done");
  expect((await upstreamClosed)[0]).toBe(1000);
});

test("quota admission trusts allowed, not rounded percent, and unknown quota fails closed", async () => {
  expect(usageAllowed({ rate_limit: { allowed: true, limit_reached: false, primary_window: { used_percent: 100 } } })).toBe(true);
  expect(usageAllowed({ rate_limit: null })).toBe(false);
  expect(usageAllowed({ rate_limit: { allowed: true, limit_reached: false }, additional_rate_limits: [
    { normal_model_slug: "special", rate_limit: { allowed: false, limit_reached: true } },
  ] }, "special")).toBe(false);
  const f = await setup();
  f.usage.set("Bearer a-access", { rate_limit: null });
  f.usage.set("Bearer b-access", { rate_limit: { allowed: false, limit_reached: true } });
  expect((await rejected(f.wsUrl)).status).toBe(503);
  expect(f.handshakes).toHaveLength(0);
});

test("concurrent account managers refresh once and persist rotated tokens privately", async () => {
  const f = await setup();
  await f.accounts.store.update(data => { data.accounts[0]!.expiresAt = 0; });
  const other = new Accounts(f.accounts.store, f.transport);
  const refreshed = await Promise.all([f.accounts.token(f.a.id), other.token(f.a.id)]);
  expect(refreshed.map(account => account.accessToken)).toEqual(["a-refreshed", "a-refreshed"]);
  expect(f.calls.filter(call => call.path === "/oauth/token")).toHaveLength(1);
  const data = JSON.parse(await readFile(f.accounts.store.path, "utf8"));
  expect(data.accounts[0].refreshToken).toBe("a-refresh-rotated");
  expect((await stat(f.accounts.store.path)).mode & 0o777).toBe(0o600);
  expect(JSON.stringify(await f.accounts.status())).not.toContain("a-refreshed");
});

test("invalid_grant disables the account without a refresh loop", async () => {
  const f = await setup();
  f.options.refreshError = true;
  await f.accounts.store.update(data => { data.accounts[0]!.expiresAt = 0; });
  await expect(f.accounts.token(f.a.id)).rejects.toThrow();
  expect((await f.accounts.store.read()).accounts[0]!.disabled).toBe(true);
  await expect(f.accounts.token(f.a.id)).rejects.toThrow();
  expect(f.calls.filter(call => call.path === "/oauth/token")).toHaveLength(1);
});

test("401 handshake refreshes once on the same account, before sending any frames", async () => {
  const f = await setup();
  f.usage.set("Bearer b-access", { rate_limit: { allowed: false, limit_reached: true } });
  Object.assign(f.options, { rejectStatus: 401, rejectToken: "Bearer a-access", rejectBody: "expired" });
  const { socket } = await openSocket(f.wsUrl);
  expect(f.handshakes.map(headers => headers.authorization)).toEqual(["Bearer a-access", "Bearer a-refreshed"]);
  expect(f.handshakes.map(headers => headers["chatgpt-account-id"])).toEqual(["a", "a"]);
  expect(f.calls.filter(call => call.path === "/oauth/token")).toHaveLength(1);
  expect(f.frames).toHaveLength(0);
  socket.close();
});

test("native relay enforces its byte limit in both directions without replay", async () => {
  for (const direction of ["input", "output"]) {
    const f = await setup();
    if (direction === "output") f.options.onFrame = socket => { socket.send("123456789"); };
    const upstream = new WebSocket(f.transport.endpoints.responses);
    const relay = new NativeRelay(upstream, 8);
    await once(upstream, "open");
    const local = Bun.serve<NativeRelay>({ port: 0, fetch(request, server) { server.upgrade(request, { data: relay }); },
      websocket: { open(ws) { ws.data.attach(ws); }, message(ws, data) { ws.data.send(data); }, close(ws, code, reason) { ws.data.close(code, reason); } } });
    try {
      const { socket } = await openSocket(`ws://127.0.0.1:${local.port}`);
      const closed = once(socket, "close");
      socket.send(direction === "input" ? "123456789" : "short");
      expect((await closed)[0]).toBe(1013);
      expect(f.frames).toHaveLength(direction === "input" ? 0 : 1);
    } finally { upstream.terminate(); await local.stop(true); }
  }
});

test("device flow polls pending, then uses form-encoded code exchange with exact redirect/PKCE", async () => {
  const f = await setup();
  f.options.pollPending = true;
  let prompt: string[] = [];
  const result = await deviceLogin(f.transport, (url, code) => { prompt = [url, code]; });
  expect(prompt).toEqual([`${f.transport.endpoints.issuer}/codex/device`, "ABCD"]);
  expect(result.access_token).toBe("a-refreshed");
  expect(f.calls.filter(call => call.path.endsWith("/deviceauth/token"))).toHaveLength(2);
  const exchange = f.calls.find(call => call.path === "/oauth/token")!;
  expect(exchange.headers["content-type"]).toContain("application/x-www-form-urlencoded");
  const body = new URLSearchParams(exchange.body);
  expect(body.get("code_verifier")).toBe("verifier");
  expect(body.get("redirect_uri")).toBe(`${f.transport.endpoints.issuer}/deviceauth/callback`);
  expect(body.get("grant_type")).toBe("authorization_code");
});

function rejected(url: string, headers: Record<string, string> = {}) {
  const socket = new WebSocket(url, { headers: { authorization: "Bearer local-key", "session-id": "test", ...headers } });
  return new Promise<{ status: number; body: string; headers: import("node:http").IncomingHttpHeaders }>((resolve, reject) => {
    socket.on("error", () => {});
    socket.on("open", () => { socket.terminate(); reject(new Error("Unexpected upgrade")); });
    socket.on("unexpected-response", (_req, res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("error", reject);
      res.on("end", () => { resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString(), headers: res.headers }); socket.terminate(); });
    });
  });
}
