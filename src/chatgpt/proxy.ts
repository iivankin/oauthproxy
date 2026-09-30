import type { Server } from "bun";
import { z } from "zod";
import { Accounts, SelectionError } from "./accounts.ts";
import { UpstreamError } from "./transport.ts";
import { responseHeaders } from "../codex/headers.ts";
import { NativeRelay } from "../codex/relay.ts";
import { connectUpstream } from "../codex/websocket.ts";
import { Stats } from "../stats.ts";

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

function observeFailures(body: ReadableStream<Uint8Array>, onLimit: () => void) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) { controller.close(); return; }
        pending += decoder.decode(chunk.value, { stream: true });
        // Inspect only completed SSE events; never change the bytes sent to the client.
        const frames = pending.split(/\r?\n\r?\n/);
        pending = frames.pop() ?? "";
        for (const frame of frames) {
          const data = frame.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
          if (!data) continue;
          try {
            const event = JSON.parse(data);
            if (event.type === "response.failed" && event.response?.error?.code === limitCode) onLimit();
          } catch { /* Unknown SSE data remains untouched. */ }
        }
        if (pending.length > 256_000) pending = "";
        controller.enqueue(chunk.value);
      } catch (cause) { controller.error(cause); }
    },
    cancel(reason) { return reader.cancel(reason); },
  }, { highWaterMark: 0 });
}

export async function streamResponses(accounts: Accounts, request: Request, stats = new Stats()) {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json"))
    return error(415, "Content-Type must be application/json");
  let input: unknown;
  try { input = await request.json(); } catch { return error(400, "Invalid JSON"); }
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success || "previous_response_id" in parsed.data)
    return error(400, "Supply model and full input array; HTTP continuation cannot use previous_response_id");
  const body = JSON.stringify({ ...parsed.data, store: false, stream: true });
  const id = await accounts.choose(parsed.data.model);
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(600_000)]);
  const upstream = await stats.http("ChatGPT", id, signal, () => accounts.authorized(id,
    account => accounts.transport.responses(account, body, signal)));
  if (upstream.status === 429) {
    try {
      const payload = await upstream.clone().json();
      if (payload?.error?.code === limitCode) accounts.limit(id, upstream.headers.get("retry-after"));
    } catch { /* Non-JSON 429 is passed through without changing account selection. */ }
  }
  const headers = responseHeaders(upstream.headers);
  headers.delete("content-encoding");
  headers.set("cache-control", "no-store");
  if (upstream.headers.get("content-type")?.startsWith("text/event-stream")) headers.set("x-accel-buffering", "no");
  return new Response(upstream.body && upstream.headers.get("content-type")?.startsWith("text/event-stream")
    ? observeFailures(upstream.body, () => accounts.limit(id)) : upstream.body,
  { status: upstream.status, headers });
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

export async function upgrade(accounts: Accounts, request: Request, server: Server<NativeRelay>, stats = new Stats()) {
  if (request.method !== "GET" || request.headers.get("upgrade")?.toLowerCase() !== "websocket")
    return error(426, "Use WebSocket upgrade or POST with stream: true");
  if (request.headers.get("sec-websocket-version") !== "13" ||
    !/^[+/0-9A-Za-z]{22}==$/.test(request.headers.get("sec-websocket-key") ?? "") ||
    request.headers.has("sec-websocket-protocol")) return error(400, "Invalid WebSocket upgrade");
  const id = await accounts.choose();
  request.signal.throwIfAborted();
  const done = stats.start("ChatGPT", id, "WS");
  let upstream: Awaited<ReturnType<typeof connectUpstream>>;
  try {
    upstream = await accounts.authorized(id, account => connectUpstream(accounts.transport.urls.websocket,
      { authorization: `Bearer ${account.accessToken}` }, request.signal, wsRequest, frame => {
        if (typeof frame !== "string") return;
        try {
          const event = JSON.parse(frame);
          if (event.type === "response.failed" && event.response?.error?.code === limitCode) accounts.limit(id);
        } catch { /* Unknown WebSocket events pass through. */ }
      }));
  } catch (cause) { done(request.signal.aborted ? "cancelled" : "errors"); throw cause; }
  upstream.socket.once("close", code => done([1000, 1001, 1005].includes(code) ? "completed" : "errors"));
  if (upstream.socket.readyState === upstream.socket.CLOSED) done("errors");
  if (request.signal.aborted) { done("cancelled"); upstream.socket.terminate(); return error(499, "Client disconnected"); }
  const headers = responseHeaders(upstream.headers, true);
  if (server.upgrade(request, { data: upstream.relay, headers })) return undefined;
  done("errors");
  upstream.socket.terminate();
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
