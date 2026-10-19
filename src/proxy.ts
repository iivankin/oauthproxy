import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { Accounts } from "./accounts.ts";
import { AppError } from "./schema.ts";
import { exhaustedQuota } from "./quota.ts";
import type { UsageLimitMode } from "./quota.ts";
import { Stats } from "./stats.ts";
import { sessionId as extractSessionId, MISSING_SESSION } from "./session-id.ts";
import { endToEndHeaders, readMessage } from "./claude-request.ts";

export function authorized(request: Pick<Request, "headers">, key?: string) {
  if (!key) return true;
  const supplied = request.headers.get("x-api-key") ?? request.headers.get("authorization")?.replace(/^Bearer /i, "") ?? "";
  const a = Buffer.from(supplied), b = Buffer.from(key);
  return a.length === b.length && timingSafeEqual(a, b);
}

function errorResponse(status: number, message: string) {
  return Response.json({ type: "error", error: { type: status === 429 ? "rate_limit_error" : "api_error", message } },
    { status, headers: { "cache-control": "no-store", ...(status === 429 && { "retry-after": "30" }) } });
}

function forward(response: Response, sessionId: string, native = false) {
  const headers = endToEndHeaders(response.headers);
  if (native) return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  // fetch decodes compressed bodies; forwarding their old length/encoding corrupts responses.
  for (const header of ["content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive", "set-cookie"])
    headers.delete(header);
  headers.set("x-claude-code-session-id", sessionId);
  headers.set("cache-control", "no-store");
  return new Response(response.body, { status: response.status, headers });
}

export function handler(accounts: Accounts, key?: string, stats = new Stats()) {
  return async (request: Request): Promise<Response> => {
    try {
      if (!authorized(request, key)) return errorResponse(401, "Invalid proxy API key");
      // No browser cross-origin API access: this is a local SDK endpoint, not a web UI.
      if (request.headers.has("origin")) return errorResponse(403, "Browser origins are not supported");
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") return Response.json({ ok: true });
      if (request.method === "GET" && url.pathname === "/claude/accounts")
        return Response.json(await accounts.status(), { headers: { "cache-control": "no-store" } });
      if (request.method === "GET" && ["/v1/models", "/claude/v1/models"].includes(url.pathname)) {
        const data = await accounts.allModels();
        return Response.json({ data, has_more: false, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null });
      }
      if (request.method !== "POST" || url.pathname !== "/v1/messages") return errorResponse(404, "Not found");
      if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json"))
        return errorResponse(415, "Content-Type must be application/json");
      const submission = await readMessage(request);
      const native = submission.kind === "cli";
      const sessionId = extractSessionId(request.headers, submission.payload);
      if (!sessionId) { console.warn(`[claude] ${MISSING_SESSION}`); return errorResponse(400, MISSING_SESSION); }
      const rawUsageLimit = request.headers.get("anthropic-usage-limit");
      if (!native && rawUsageLimit !== null && rawUsageLimit !== "extended" && rawUsageLimit !== "slow")
        return errorResponse(400, "anthropic-usage-limit must be extended or slow");
      const usageLimit: UsageLimitMode | undefined = rawUsageLimit === "extended" || rawUsageLimit === "slow" ? rawUsageLimit : undefined;
      const gatewayPromptId = request.headers.get("x-claude-code-prompt-id");
      if (!native && gatewayPromptId !== null && !z.uuid().safeParse(gatewayPromptId).success)
        return errorResponse(400, "x-claude-code-prompt-id must be a UUID");
      const promptId = gatewayPromptId ?? crypto.randomUUID();
      const excluded = new Set<string>();
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(600_000)]);
      const preferredId = submission.kind === "sdk" ? await accounts.continuationAccount(sessionId, submission.input) : undefined;
      const chooseOptions = { sessionId, ...(usageLimit && { usageLimit }), ...(preferredId && { preferredId }) };
      const send = submission.kind === "cli"
        ? (id: string) => accounts.nativeMessage(id, submission.wire, signal)
        : (id: string) => accounts.message(id, submission.input, sessionId, promptId,
          [...(submission.input.betas ?? []), ...(request.headers.get("anthropic-beta") ?? "").split(",")].map(s => s.trim()).filter(Boolean), signal,
          { ...(usageLimit && { usageLimit }), ...(gatewayPromptId && { gatewayPromptId }) });
      let id = await accounts.choose(submission.model, excluded, chooseOptions);
      for (;;) {
        excluded.add(id);
        const response = await stats.http("Claude", id, signal, () => send(id));
        const scope = exhaustedQuota(response);
        if (!scope) return forward(response, sessionId, native);
        accounts.limited(id, response.headers, scope === "model" ? submission.model : undefined);
        if (response.headers.get("x-should-retry") === "false") return forward(response, sessionId, native);
        // Keep the original rejection until another eligible account is found;
        // a local selection failure must not replace its body or retry headers.
        try { id = await accounts.choose(submission.model, excluded, chooseOptions); }
        catch { return forward(response, sessionId, native); }
        await response.body?.cancel();
      }
    } catch (error) {
      if (error instanceof AppError) return errorResponse(error.status, error.message);
      if (request.signal.aborted) return errorResponse(499, "Client disconnected");
      return errorResponse(502, "Upstream request or account operation failed");
    }
  };
}
