import type { IncomingHttpHeaders } from "node:http";
import { EventEmitter } from "node:events";
import type { ServerWebSocket } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { Accounts } from "../src/codex/accounts.ts";
import { AccountStore } from "../src/codex/store.ts";
import { Transport } from "../src/codex/transport.ts";
import { serve } from "../src/server.ts";
import { Accounts as ClaudeAccounts } from "../src/accounts.ts";
import { AccountStore as ClaudeStore } from "../src/store.ts";
import { Transport as ClaudeTransport } from "../src/transport.ts";
import { HistoryStore } from "../src/history-store.ts";

export const jwt = (value: unknown) => `header.${Buffer.from(JSON.stringify(value)).toString("base64url")}.signature`;
export function tokens(accountId: string, expiresIn = 3600) {
  return { access_token: `${accountId}-access`, refresh_token: `${accountId}-refresh`, expires_in: expiresIn,
    id_token: jwt({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }) };
}

export async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "oauth-proxy-test-"));
  const usage = new Map<string, unknown>();
  const frames: string[] = [];
  const handshakes: IncomingHttpHeaders[] = [];
  const calls: { path: string; headers: IncomingHttpHeaders; body: string }[] = [];
  const upstreamSockets = new Set<ServerWebSocket<undefined>>();
  const events = new EventEmitter();
  const options = {
    rejectStatus: 0, rejectBody: "", rejectToken: "", refreshError: false, pollPending: false,
    onFrame: (socket: ServerWebSocket<undefined>, frame: string) => { socket.send(frame); },
  };
  const upstream = Bun.serve<undefined>({ hostname: "127.0.0.1", port: 0,
    async fetch(req, server) {
      if (req.headers.get("upgrade") === "websocket") {
        handshakes.push(Object.fromEntries(req.headers));
        if (options.rejectStatus && (!options.rejectToken || req.headers.get("authorization") === options.rejectToken)) return new Response(options.rejectBody, { status: options.rejectStatus,
          headers: { "retry-after": "7", "x-request-id": "req_fail" } });
        server.upgrade(req, { headers: { "x-codex-turn-state": "sticky-server-value", "x-request-id": "req_test", "x-ratelimit-test": "42" } });
        return;
      }
      const path = new URL(req.url).pathname;
      calls.push({ path, headers: Object.fromEntries(req.headers), body: await req.text() });
      if (path === "/usage") return Response.json(usage.get(req.headers.get("authorization") ?? "") ?? { rate_limit: { allowed: true, limit_reached: false } });
      if (path === "/models") return Response.json({ models: [{ slug: "test-model", display_name: "Test", future: { preserved: true } }] });
      if (path === "/oauth/token") {
        if (options.refreshError) return Response.json({ error: "invalid_grant" }, { status: 400 });
        return Response.json({ ...tokens("a"), access_token: "a-refreshed", refresh_token: "a-refresh-rotated" });
      }
      if (path.endsWith("/usercode")) return Response.json({ device_auth_id: "device", user_code: "ABCD", interval: "1" });
      if (path.endsWith("/deviceauth/token")) {
        if (options.pollPending) { options.pollPending = false; return Response.json({}, { status: 403 }); }
        return Response.json({ authorization_code: "one-time-code", code_verifier: "verifier", code_challenge: "challenge" });
      }
      return new Response("{}", { status: 404 });
    },
    websocket: {
      open(client) { upstreamSockets.add(client); },
      close(client, code, reason) { upstreamSockets.delete(client); events.emit("upstream-close", code, reason); },
      message(client, data) {
        frames.push(data.toString());
        if (typeof data !== "string") client.sendBinary(data);
        else options.onFrame(client, data);
      },
    },
  });
  const base = `http://127.0.0.1:${upstream.port}`;
  const transport = new Transport({ issuer: base, usage: `${base}/usage`, models: `${base}/models`, responses: `${base.replace("http", "ws")}/responses` });
  const accounts = new Accounts(new AccountStore(join(directory, "codex-accounts.json")), transport);
  const a = await accounts.add(tokens("a"), "A");
  const b = await accounts.add(tokens("b"), "B");
  const claudeStore = new ClaudeStore(join(directory, "accounts.json"));
  await claudeStore.update(data => { data.accounts.push({ id: "claude", name: "Claude", email: "test@invalid", accountUuid: crypto.randomUUID(),
    organizationId: "org", deviceId: "a".repeat(64), disabled: false, accessToken: "claude-token", expiresAt: Date.now() + 3600_000,
    clientId: "test", scopes: [] }); });
  const claude = new ClaudeAccounts(claudeStore, new ClaudeTransport(async url => {
    const path = new URL(url).pathname;
    if (path === "/api/oauth/usage") return Response.json({ five_hour: { utilization: 1, resets_at: null }, seven_day: { utilization: 1, resets_at: null } });
    if (path === "/v1/models") return Response.json({ data: [{ id: "claude-test" }] });
    return new Response('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_test","type":"message","role":"assistant","content":[],"model":"claude-test","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n', { headers: { "content-type": "text/event-stream" } });
  }, "https://mock.invalid", "https://mock.invalid/token", new HistoryStore(join(directory, "cas"))));
  const proxy = serve(claude, "127.0.0.1", 0, "local-key", accounts);
  const url = proxy.url.toString();
  return { accounts, transport, a, b, directory, options, usage, calls, frames, handshakes, upstreamSockets, events,
    url, wsUrl: `${url.replace("http", "ws")}v1/responses`,
    async close() {
      await proxy.stop();
      for (const socket of upstreamSockets) socket.terminate();
      await upstream.stop(true);
      await rm(directory, { recursive: true, force: true });
    },
  };
}

export function openSocket(url: string, headers: Record<string, string> = {}) {
  const socket = new WebSocket(url, { headers: { authorization: "Bearer local-key", "session-id": "test-session", ...headers } });
  return new Promise<{ socket: WebSocket; headers: IncomingHttpHeaders }>((resolve, reject) => {
    let reply: IncomingHttpHeaders = {};
    socket.on("upgrade", response => { reply = response.headers; });
    socket.on("error", reject);
    socket.on("open", () => resolve({ socket, headers: reply }));
  });
}
