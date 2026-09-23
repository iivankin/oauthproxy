import { z } from "zod";
import { Accounts } from "./accounts.ts";
import { responseHeaders } from "./headers.ts";
import { proxyError } from "./proxy.ts";

const requestSchema = z.object({
  model: z.string().min(1), input: z.union([z.string(), z.array(z.unknown())]), stream: z.literal(true),
}).passthrough();

export async function streamResponses(accounts: Accounts, request: Request) {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json"))
    return proxyError(415, "Content-Type must be application/json");
  const body = await request.text();
  let raw: unknown;
  try { raw = JSON.parse(body); } catch { return proxyError(400, "Invalid JSON"); }
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) return proxyError(400, "SSE requires model, input and stream: true");
  const sessionId = request.headers.get("session-id") || crypto.randomUUID();
  if (!request.headers.get("session-id")) console.warn("[codex] Missing session-id; created a session for this request");
  const id = await accounts.choose(parsed.data.model);
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(600_000)]);
  signal.throwIfAborted();
  let response: Response;
  try {
    response = await accounts.authorized(id, account =>
      accounts.transport.responses(account, body, request.headers, sessionId, signal));
  } finally { accounts.invalidateUsage(id); }
  const headers = responseHeaders(response.headers);
  headers.delete("content-encoding"); // fetch has already decoded the upstream body.
  headers.set("session-id", sessionId);
  headers.set("cache-control", "no-store");
  if (response.headers.get("content-type")?.startsWith("text/event-stream")) headers.set("x-accel-buffering", "no");
  // Do not parse SSE: retain event framing, unknown fields, refusals and in-stream errors.
  return new Response(response.body, { status: response.status, headers });
}
