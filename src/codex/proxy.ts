import type { Server } from "bun";
import { Accounts, SelectionError } from "./accounts.ts";
import { responseHeaders } from "./headers.ts";
import { websocketHeaders } from "./profile.ts";
import { NativeRelay } from "./relay.ts";
import { UpstreamError } from "./transport.ts";
import { connectUpstream } from "./websocket.ts";

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

export async function upgrade(accounts: Accounts, request: Request, server: Server<NativeRelay>) {
  const headers = request.headers;
  if (request.method !== "GET" || headers.get("upgrade")?.toLowerCase() !== "websocket")
    return proxyError(426, "Use WebSocket upgrade, not HTTP/SSE");
  if (headers.get("sec-websocket-version") !== "13" || !/^[+/0-9A-Za-z]{22}==$/.test(headers.get("sec-websocket-key") ?? "") ||
    headers.has("sec-websocket-protocol")) return proxyError(400, "Expected standard WebSocket upgrade without subprotocol");
  const sessionId = headers.get("session-id") || crypto.randomUUID();
  if (!headers.get("session-id")) console.warn("[codex] Missing session-id; created a session for this connection");
  const model = new URL(request.url).searchParams.get("model") || undefined;
  const id = await accounts.choose(model);
  request.signal.throwIfAborted();
  const upstream = await accounts.authorized(id, account => connectUpstream(accounts.transport.endpoints.responses,
    websocketHeaders(account, headers, sessionId, accounts.transport.version), request.signal));
  upstream.relay.onClose = () => accounts.invalidateUsage(id);
  if (request.signal.aborted) { upstream.socket.terminate(); return proxyError(499, "Client disconnected"); }
  const reply = responseHeaders(upstream.headers, true);
  reply.set("session-id", sessionId);
  if (server.upgrade(request, { data: upstream.relay, headers: reply })) return undefined;
  upstream.socket.terminate();
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
