import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import { Stream } from "@anthropic-ai/sdk/core/streaming";
import type { MessageCreateParamsBase } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { messageSchema, tokensSchema, type Account, type Tokens, type Message } from "./schema.ts";
import { BASE_BETAS, USER_AGENT, prepareBody } from "./profile.ts";
import { signBody } from "./signing.ts";
import { relayMessage } from "./message-stream.ts";
import { HistoryStore } from "./history-store.ts";
import { historyHash, previousHistoryHash } from "./history.ts";

export type Fetch = (url: string | URL, init?: RequestInit) => Promise<Response>;
export const OAUTH = {
  clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  authorize: "https://claude.com/cai/oauth/authorize",
  token: "https://platform.claude.com/v1/oauth/token",
  manualRedirect: "https://platform.claude.com/oauth/code/callback",
  scopes: ["user:profile", "user:inference", "user:sessions:claude_code", "user:mcp_servers", "user:file_upload", "user:plugins"],
};

export class UpstreamError extends Error {
  constructor(public status: number, public code: string) {
    super(`Anthropic HTTP ${status} (${code})`);
  }
}

class UpstreamResponse extends Error {
  constructor(readonly response: Response) { super(`Upstream HTTP ${response.status}`); }
}

export async function jsonResponse(response: Response): Promise<unknown> {
  let value: unknown;
  try { value = await response.json(); }
  catch { throw new UpstreamError(response.status, "invalid_json_response"); }
  if (!response.ok) {
    const error = z.object({ error: z.union([z.string(), z.object({ type: z.string() })]) }).safeParse(value);
    const code = error.success ? (typeof error.data.error === "string" ? error.data.error : error.data.error.type) : "upstream_error";
    // Don't echo arbitrary upstream bodies: token endpoints can contain credentials.
    throw new UpstreamError(response.status, code);
  }
  return value;
}

const tokenResponseSchema = z.object({
  access_token: z.string().min(1), refresh_token: z.string().min(1).optional(),
  expires_in: z.number().positive(), scope: z.string().optional(),
});

export class Transport {
  constructor(readonly fetcher: Fetch = fetch, readonly origin = "https://api.anthropic.com", readonly tokenUrl = OAUTH.token,
    readonly history = new HistoryStore()) {}

  private client(account: Tokens, sessionId?: string) {
    return new Anthropic({
      apiKey: null, authToken: account.accessToken, baseURL: this.origin,
      maxRetries: 0, timeout: 600_000, logLevel: "off", dangerouslyAllowBrowser: true,
      middleware: [async (request, next) => {
        const response = await next(request);
        // Public SDK middleware errors propagate unchanged. Intercept HTTP
        // failures before the SDK consumes/reconstructs their JSON or text body.
        if (!response.ok) throw new UpstreamResponse(response);
        return response;
      }],
      fetch: (url, init) => {
        const target = url instanceof Request ? url.url : String(url);
        const messageRequest = init?.method === "POST" && new URL(target).pathname === "/v1/messages";
        const headers = new Headers(init?.headers);
        if (messageRequest) {
          headers.set("x-claude-code-request-class", "main");
          headers.set("x-client-request-id", crypto.randomUUID());
        }
        const body = messageRequest && typeof init?.body === "string" ? signBody(init.body) : init?.body;
        return this.fetcher(target, { ...init, headers, body, redirect: "error" });
      },
      defaultHeaders: { "user-agent": USER_AGENT, ...(sessionId && { "X-Claude-Code-Session-Id": sessionId }),
        "anthropic-beta": BASE_BETAS.join(","), "x-app": "cli" },
    });
  }

  private async response(operation: PromiseLike<Response>): Promise<Response> {
    try { return await operation; }
    catch (error) {
      if (error instanceof UpstreamResponse) return error.response;
      throw error;
    }
  }

  async tokenRequest(body: Record<string, unknown>, previous?: Tokens): Promise<Tokens> {
    const response = await this.fetcher(this.tokenUrl, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(30_000),
    });
    const data = tokenResponseSchema.parse(await jsonResponse(response));
    return tokensSchema.parse({
      accessToken: data.access_token, refreshToken: data.refresh_token ?? previous?.refreshToken,
      expiresAt: Date.now() + data.expires_in * 1000,
      scopes: data.scope?.split(/\s+/).filter(Boolean) ?? previous?.scopes ?? OAUTH.scopes,
      clientId: body.client_id,
    });
  }

  refresh(account: Account): Promise<Tokens> {
    if (!account.refreshToken) throw new Error("Account requires login: no refresh token");
    return this.tokenRequest({
      grant_type: "refresh_token", refresh_token: account.refreshToken,
      client_id: account.clientId,
      ...(account.scopes.length > 0 && { scope: account.scopes.join(" ") }),
    }, account);
  }

  request(account: Tokens, path: string) {
    return this.response(this.client(account).get(path, { timeout: 15_000 }).asResponse());
  }

  async message(account: Account, input: Message, sessionId: string, promptId: string, betas: string[], signal: AbortSignal) {
    const previous = await this.history.get(sessionId, account.id, previousHistoryHash(input.messages));
    const body = prepareBody(input, { account, sessionId, promptId, previousRequestId: previous?.requestId, previousMessageId: previous?.messageId });
    // The proxy validates the envelope but preserves arbitrary API content/tool
    // blocks, including newer beta fields. Anthropic validates those server-side.
    const params = { ...body, betas: [...new Set([...BASE_BETAS, ...betas])] } as MessageCreateParamsBase;
    const upstream = new AbortController();
    const operation = this.client(account, sessionId).beta.messages.create(params,
      { signal: AbortSignal.any([signal, upstream.signal]) });
    const save = async (message: { id: string; content: unknown }, requestId: string | null | undefined) => {
      if (!requestId || !/^req_[A-Za-z0-9_-]{1,36}$/.test(requestId) || !/^msg_[A-Za-z0-9_-]+$/.test(message.id)) return;
      const parsed = messageSchema.shape.messages.element.safeParse({ role: "assistant", content: message.content });
      if (!parsed.success) return;
      await this.history.put({ version: 1, sessionId, accountId: account.id,
        historyHash: historyHash([...input.messages, parsed.data]), messageId: message.id, requestId });
    };
    if (input.stream) {
      const response = await this.response(operation.asResponse());
      return relayMessage(response, message => save(message, response.headers.get("request-id")), upstream);
    }
    return this.response(operation.withResponse().then(async ({ data, response, request_id }) => {
      if (data instanceof Stream) throw new Error("Unexpected stream for a JSON request");
      await save(data, request_id);
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      headers.delete("content-encoding");
      return Response.json(data, { status: response.status, headers });
    }));
  }
}
