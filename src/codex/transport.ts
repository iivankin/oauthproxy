import { CODEX_VERSION, CLIENT_ID, ENDPOINTS, authHeaders, responsesHeaders, type Endpoints } from "./profile.ts";
import { tokensSchema, type Account } from "./schema.ts";

export class UpstreamError extends Error {
  constructor(readonly status: number, readonly body: Uint8Array, readonly headers: Headers) {
    super(`Upstream HTTP ${status}`);
  }
}

export class Transport {
  constructor(readonly endpoints: Endpoints = ENDPOINTS, readonly version = CODEX_VERSION) {}

  async request(url: string, options: RequestInit = {}) {
    // Never redirect a bearer token or automatically retry a rotating refresh-token exchange.
    const response = await fetch(url, { ...options, redirect: "error", signal: options.signal ?? AbortSignal.timeout(20_000) });
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!response.ok) throw new UpstreamError(response.status, bytes, response.headers);
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  }

  async refresh(refreshToken: string) {
    return tokensSchema.parse(await this.request(`${this.endpoints.issuer}/oauth/token`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: CLIENT_ID, grant_type: "refresh_token", refresh_token: refreshToken }),
    }));
  }

  async exchange(code: string, verifier: string) {
    return tokensSchema.parse(await this.request(`${this.endpoints.issuer}/oauth/token`, {
      method: "POST", body: new URLSearchParams({ client_id: CLIENT_ID, grant_type: "authorization_code",
        code, code_verifier: verifier, redirect_uri: `${this.endpoints.issuer}/deviceauth/callback` }),
    }));
  }

  get(url: string, account: Account) { return this.request(url, { headers: authHeaders(account, this.version) }); }

  async responses(account: Account, body: string, incoming: Headers, sessionId: string, signal: AbortSignal) {
    const response = await fetch(this.endpoints.responsesHttp, {
      method: "POST", redirect: "error", body, signal,
      headers: { ...responsesHeaders(account, incoming, sessionId, this.version),
        "content-type": "application/json", accept: "text/event-stream" },
    });
    // Only auth rejection enters the existing refresh path; all other bodies stay streaming.
    if (response.status === 401)
      throw new UpstreamError(401, new Uint8Array(await response.arrayBuffer()), response.headers);
    return response;
  }
}
