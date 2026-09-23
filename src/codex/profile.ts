import { arch, release, type } from "node:os";
import type { Account } from "./schema.ts";

export const CODEX_VERSION = "0.156.1";
export const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const ENDPOINTS = {
  issuer: "https://auth.openai.com",
  responses: "wss://chatgpt.com/backend-api/codex/responses",
  models: "https://chatgpt.com/backend-api/codex/models",
  usage: "https://chatgpt.com/backend-api/wham/usage",
};
export type Endpoints = typeof ENDPOINTS;

export function authHeaders(account: Account, version = CODEX_VERSION): Record<string, string> {
  return {
    authorization: `Bearer ${account.accessToken}`, "chatgpt-account-id": account.accountId,
    "accept-encoding": "identity",
    originator: "codex_cli_rs", version,
    "user-agent": `codex_cli_rs/${version} (${type()} ${release()}; ${arch()}) codex-oauth-proxy/0.1.0`,
  };
}

export function websocketHeaders(account: Account, incoming: Headers, sessionId: string, version = CODEX_VERSION) {
  const headers = authHeaders(account, version);
  headers["openai-beta"] = "responses_websockets=2026-02-06";
  headers["session-id"] = sessionId;
  headers["thread-id"] = incoming.get("thread-id") || sessionId;
  headers["x-client-request-id"] = incoming.get("x-client-request-id") || headers["thread-id"];
  const features = incoming.get("x-codex-beta-features");
  if (features) headers["x-codex-beta-features"] = features;
  // No stale routing/attestation from a different account; native WS connect also starts without turn-state.
  return headers;
}
