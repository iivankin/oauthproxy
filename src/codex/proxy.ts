import type { Server } from "bun";
import { Accounts, SelectionError } from "./accounts.ts";
import { responseHeaders } from "./headers.ts";
import { websocketHeaders } from "./profile.ts";
import type { SocketRelay } from "./relay.ts";
import { UpstreamError } from "./transport.ts";
import { connectUpstream } from "./websocket.ts";
import { Stats } from "../stats.ts";
import { sessionId as extractSessionId } from "../session-id.ts";
import { AccountSocket } from "../account-socket.ts";
import { responseError } from "../responses-events.ts";

export function proxyError(status: number, message: string) {
  return Response.json({ error: { type: "proxy_error", message } }, { status, headers: { "cache-control": "no-store" } });
}

export function upstreamError(error: unknown) {
  if (error instanceof UpstreamError) {
    const headers = responseHeaders(error.headers);
    // fetch decompresses bodies; WebSocket handshake rejections are requested uncompressed.
    headers.delete("content-encoding");
    return new Response(Buffer.from(error.body), { status: error.status, headers });
  }
  return proxyError(error instanceof SelectionError ? 503 : 502,
    error instanceof SelectionError ? error.message : "Codex account or upstream operation failed");
}

export async function upgrade(accounts: Accounts, request: Request, server: Server<SocketRelay>, stats = new Stats()) {
  const headers = request.headers;
  if (request.method !== "GET" || headers.get("upgrade")?.toLowerCase() !== "websocket")
    return proxyError(426, "Use WebSocket upgrade or POST with stream: true");
  if (headers.get("sec-websocket-version") !== "13" || !/^[+/0-9A-Za-z]{22}==$/.test(headers.get("sec-websocket-key") ?? "") ||
    headers.has("sec-websocket-protocol")) return proxyError(400, "Expected standard WebSocket upgrade without subprotocol");
  const sessionId = extractSessionId(headers) ?? crypto.randomUUID();
  let relay: AccountSocket | undefined;
  const connect = async (id: string, signal: AbortSignal) => {
    const done = stats.start("Codex", id, "WS");
    try {
      const upstream = await accounts.authorized(id, account => connectUpstream(accounts.transport.endpoints.responses,
        websocketHeaders(account, headers, sessionId, accounts.transport.version), signal, undefined, frame => {
          if (typeof frame !== "string") return;
          try {
            const event: unknown = JSON.parse(frame);
            const error = responseError(event);
            if (error?.type === "usage_limit_reached" || error?.code === "usage_limit_reached") {
              accounts.limit(id, error);
              relay?.limited(id);
            }
          } catch { /* Unknown frames pass through. */ }
        }));
      upstream.socket.once("close", code => done([1000, 1001, 1005].includes(code) ? "completed" : "errors"));
      if (upstream.socket.readyState === upstream.socket.CLOSED) done("errors");
      upstream.relay.onClose = () => accounts.invalidateUsage(id);
      return upstream;
    } catch (cause) { done(signal.aborted ? "cancelled" : "errors"); throw cause; }
  };
  const id = await accounts.choose();
  request.signal.throwIfAborted();
  const upstream = await connect(id, request.signal);
  relay = new AccountSocket(id, upstream, {
    choose: (model, excluded) => accounts.choose(model, undefined, excluded), connect, error: upstreamError,
    quota: event => { const error = responseError(event); return error?.type === "usage_limit_reached" || error?.code === "usage_limit_reached"; },
  });
  if (request.signal.aborted) { relay.close(1001, "Client disconnected"); return proxyError(499, "Client disconnected"); }
  const reply = responseHeaders(upstream.headers, true);
  reply.set("session-id", sessionId);
  if (server.upgrade(request, { data: relay, headers: reply })) return undefined;
  relay.close(1008, "WebSocket upgrade rejected");
  return proxyError(400, "WebSocket upgrade rejected");
}

export async function codexHttp(accounts: Accounts, request: Request) {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/codex/accounts")
    return Response.json(await accounts.status(), { headers: { "cache-control": "no-store" } });
  if (request.method === "GET" && url.pathname === "/codex/usage") {
    const id = url.searchParams.get("account");
    if (!id) return proxyError(400, "Supply ?account=<local account ID>");
    return Response.json(await accounts.usage(id, true), { headers: { "cache-control": "no-store" } });
  }
  if (request.method === "GET" && url.pathname === "/codex/v1/models")
    return Response.json(await accounts.catalog(), { headers: { "cache-control": "no-store" } });
  return proxyError(404, "Not found");
}
