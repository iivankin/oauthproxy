import type { Server } from "bun";
import { z } from "zod";
import { Accounts, SelectionError } from "./accounts.ts";
import { UpstreamError } from "./transport.ts";
import { responseHeaders } from "../codex/headers.ts";
import type { SocketRelay } from "../codex/relay.ts";
import { connectUpstream } from "../codex/websocket.ts";
import { Stats } from "../stats.ts";
import { sessionId as extractSessionId, MISSING_SESSION } from "../session-id.ts";
import { AccountSocket } from "../account-socket.ts";
import { responseError } from "../responses-events.ts";
import { quotaFailover } from "../quota-failover.ts";

const requestSchema = z.object({ model: z.string().min(1), input: z.array(z.unknown()),
  stream: z.literal(true).optional() }).passthrough();
const limitCode = "subscription_sharing_usage_limit_exceeded";

function error(status: number, message: string) {
  return Response.json({ error: { type: "proxy_error", message } }, { status, headers: { "cache-control": "no-store" } });
}

export function upstreamError(cause: unknown) {
  if (cause instanceof UpstreamError) {
    const headers = responseHeaders(cause.headers);
    headers.delete("content-encoding");
    return new Response(Buffer.from(cause.body), { status: cause.status, headers });
  }
  return error(cause instanceof SelectionError ? 503 : 502,
    cause instanceof SelectionError ? cause.message : "ChatGPT account or upstream operation failed");
}

export async function streamResponses(accounts: Accounts, request: Request, stats = new Stats()) {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json"))
    return error(415, "Content-Type must be application/json");
  let input: unknown;
  try { input = await request.json(); } catch { return error(400, "Invalid JSON"); }
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) return error(400, "Supply model and input array");
  const sessionId = extractSessionId(request.headers, input);
  if (!sessionId) { console.warn(`[chatgpt] ${MISSING_SESSION}`); return error(400, MISSING_SESSION); }
  const body = JSON.stringify({ ...parsed.data, store: false, stream: true });
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(600_000)]);
  const upstream = await quotaFailover({
    retry: !parsed.data.previous_response_id,
    choose: excluded => accounts.choose(parsed.data.model, sessionId, excluded),
    execute: id => stats.http("ChatGPT", id, signal, () => accounts.authorized(id,
      account => accounts.transport.responses(account, body, signal))),
    quota: event => responseError(event)?.code === limitCode,
    limit: (id, headers) => accounts.limit(id, headers.get("retry-after")),
  });
  const headers = responseHeaders(upstream.headers);
  headers.delete("content-encoding");
  headers.set("cache-control", "no-store");
  headers.set("session-id", sessionId);
  if (upstream.headers.get("content-type")?.startsWith("text/event-stream")) headers.set("x-accel-buffering", "no");
  return new Response(upstream.body, { status: upstream.status, headers });
}

function wsRequest(frame: string | Buffer) {
  if (typeof frame !== "string") return frame;
  const event = JSON.parse(frame);
  if (event?.type !== "response.create") return frame;
  if (typeof event.model !== "string" || !Array.isArray(event.input)) throw new Error("Invalid response.create");
  // The subscription-sharing route requires stateless inference even on a WebSocket.
  event.store = false;
  delete event.stream;
  return JSON.stringify(event);
}

export async function upgrade(accounts: Accounts, request: Request, server: Server<SocketRelay>, stats = new Stats()) {
  if (request.method !== "GET" || request.headers.get("upgrade")?.toLowerCase() !== "websocket")
    return error(426, "Use WebSocket upgrade or POST with stream: true");
  if (request.headers.get("sec-websocket-version") !== "13" ||
    !/^[+/0-9A-Za-z]{22}==$/.test(request.headers.get("sec-websocket-key") ?? "") ||
    request.headers.has("sec-websocket-protocol")) return error(400, "Invalid WebSocket upgrade");
  let relay: AccountSocket | undefined;
  const connect = async (id: string, signal: AbortSignal) => {
    const done = stats.start("ChatGPT", id, "WS");
    try {
      const upstream = await accounts.authorized(id, account => connectUpstream(accounts.transport.urls.websocket,
        { authorization: `Bearer ${account.accessToken}` }, signal, wsRequest, frame => {
          if (typeof frame !== "string") return;
          try {
            if (responseError(JSON.parse(frame))?.code === limitCode) { accounts.limit(id); relay?.limited(id); }
          }
          catch { /* Unknown WebSocket events pass through. */ }
        }));
      upstream.socket.once("close", code => done([1000, 1001, 1005].includes(code) ? "completed" : "errors"));
      if (upstream.socket.readyState === upstream.socket.CLOSED) done("errors");
      return upstream;
    } catch (cause) { done(signal.aborted ? "cancelled" : "errors"); throw cause; }
  };
  const id = await accounts.choose();
  request.signal.throwIfAborted();
  const upstream = await connect(id, request.signal);
  relay = new AccountSocket(id, upstream, { choose: (model, excluded) => accounts.choose(model, undefined, excluded),
    connect, error: upstreamError, quota: event => responseError(event)?.code === limitCode });
  if (request.signal.aborted) { relay.close(1001, "Client disconnected"); return error(499, "Client disconnected"); }
  const headers = responseHeaders(upstream.headers, true);
  headers.set("session-id", extractSessionId(request.headers) ?? crypto.randomUUID());
  if (server.upgrade(request, { data: relay, headers })) return undefined;
  relay.close(1008, "WebSocket upgrade rejected");
  return error(400, "WebSocket upgrade rejected");
}

export async function chatgptHttp(accounts: Accounts, request: Request) {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/chatgpt/accounts")
    return Response.json(await accounts.status(), { headers: { "cache-control": "no-store" } });
  if (request.method === "GET" && url.pathname === "/chatgpt/v1/models")
    return Response.json(await accounts.catalog(), { headers: { "cache-control": "no-store" } });
  if (request.method === "GET" && url.pathname === "/chatgpt/usage")
    return Response.json({ reported: false, settingsUrl: "https://chatgpt.com/#settings/Usage" },
      { headers: { "cache-control": "no-store" } });
  return error(404, "Not found");
}
