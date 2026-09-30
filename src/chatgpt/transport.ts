import { tokenSchema, type Account, type Endpoints, endpoints } from "./types.ts";

export class UpstreamError extends Error {
  constructor(readonly status: number, readonly body: Uint8Array, readonly headers: Headers) {
    super(`Upstream HTTP ${status}`);
  }
}

export class Transport {
  constructor(readonly urls: Endpoints = endpoints) {}

  async request(url: string, options: RequestInit = {}) {
    const response = await fetch(url, { ...options, redirect: "error", signal: options.signal ?? AbortSignal.timeout(20_000) });
    const body = new Uint8Array(await response.arrayBuffer());
    if (!response.ok) throw new UpstreamError(response.status, body, response.headers);
    return JSON.parse(new TextDecoder().decode(body)) as unknown;
  }

  async exchange(clientId: string, code: string, verifier: string, redirectUri: string) {
    return tokenSchema.parse(await this.request(this.urls.token, { method: "POST",
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, code,
        code_verifier: verifier, redirect_uri: redirectUri, resource: this.urls.resource }) }));
  }

  async refresh(account: Account) {
    return tokenSchema.parse(await this.request(this.urls.token, { method: "POST",
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: account.clientId,
        refresh_token: account.refreshToken, resource: this.urls.resource }) }));
  }

  async models(account: Account) {
    return this.request(this.urls.models, { headers: { authorization: `Bearer ${account.accessToken}` } });
  }

  async responses(account: Account, body: string, signal: AbortSignal) {
    const response = await fetch(this.urls.responses, { method: "POST", redirect: "error", body, signal,
      headers: { authorization: `Bearer ${account.accessToken}`, "content-type": "application/json", accept: "text/event-stream" } });
    if (response.status === 401) throw new UpstreamError(401, new Uint8Array(await response.arrayBuffer()), response.headers);
    return response;
  }
}
