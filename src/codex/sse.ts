import { z } from "zod";
import { Accounts } from "./accounts.ts";
import { responseHeaders } from "./headers.ts";
import { proxyError } from "./proxy.ts";
import { Stats } from "../stats.ts";
import { sessionId as extractSessionId, MISSING_SESSION } from "../session-id.ts";
import { responseError } from "../responses-events.ts";
import { quotaFailover } from "../quota-failover.ts";

const requestSchema = z.object({
  model: z.string().min(1), input: z.union([z.string(), z.array(z.unknown())]), stream: z.literal(true),
}).passthrough();

export async function streamResponses(accounts: Accounts, request: Request, stats = new Stats()) {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json"))
    return proxyError(415, "Content-Type must be application/json");
  const body = await request.text();
  let raw: unknown;
  try { raw = JSON.parse(body); } catch { return proxyError(400, "Invalid JSON"); }
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) return proxyError(400, "SSE requires model, input and stream: true");
  const sessionId = extractSessionId(request.headers, raw);
  if (!sessionId) { console.warn(`[codex] ${MISSING_SESSION}`); return proxyError(400, MISSING_SESSION); }
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(600_000)]);
  signal.throwIfAborted();
  const response = await quotaFailover({
    retry: Array.isArray(parsed.data.input) && !parsed.data.previous_response_id,
    choose: excluded => accounts.choose(parsed.data.model, sessionId, excluded),
    async execute(id) {
      try { return await stats.http("Codex", id, signal, () => accounts.authorized(id, account =>
        accounts.transport.responses(account, body, request.headers, sessionId, signal))); }
      finally { accounts.invalidateUsage(id); }
    },
    quota: event => { const error = responseError(event); return error?.type === "usage_limit_reached" || error?.code === "usage_limit_reached"; },
    limit: (id, headers, event) => accounts.limit(id, responseError(event) ?? {}, headers.get("retry-after")),
  });
  const headers = responseHeaders(response.headers);
  headers.delete("content-encoding"); // fetch has already decoded the upstream body.
  headers.set("session-id", sessionId);
  headers.set("cache-control", "no-store");
  if (response.headers.get("content-type")?.startsWith("text/event-stream")) headers.set("x-accel-buffering", "no");
  return new Response(response.body, { status: response.status, headers });
}
