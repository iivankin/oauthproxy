# Codex API

## Accounts

```sh
bun run cli codex accounts add --name personal
bun run cli codex accounts list
bun run cli codex accounts usage
bun run cli codex accounts refresh [id]
bun run cli codex models
```

Login prints a device code and `https://auth.openai.com/codex/device`, then waits up to 15 minutes. There is no browser-login fallback.

Credentials are stored in `codex-accounts.json` in cwd, with `0600` permissions, atomic writes and a cross-process lock. The installed Codex's credentials are not touched. Tokens refresh before expiry, every 30 seconds in the background, or once after a handshake 401. Invalid refresh tokens disable the account until login.

## Connection

`WS /v1/responses?model=<slug>` forwards to `wss://chatgpt.com/backend-api/codex/responses`.

- Authenticate with `Authorization: Bearer <PROXY_API_KEY>` or `x-api-key`.
- Send `session-id`; if missing, the proxy warns, creates one and returns it in HTTP 101.
- Optional `thread-id` and `x-client-request-id` default to the session ID.
- Optional `?model=` filters accounts by catalog and known model quota. It does not replace `model` in JSON.

One connection uses one randomly selected account until it closes. Browser Origin and WebSocket subprotocols are rejected. HTTP/SSE Responses requests are not supported.

The proxy supplies account authorization, Codex version/User-Agent, `originator`, session headers and `OpenAI-Beta: responses_websockets=2026-02-06`. Client credentials, cookies and stale account/routing headers are not forwarded. TLS fingerprints and attestation are not emulated.

## Frames

JSON payloads are not rewritten. No prompts, tools, cache markers or metadata are injected.

```json
{
  "type": "response.create",
  "model": "<model-slug>",
  "instructions": "Answer briefly.",
  "input": [{"role": "user", "content": [{"type": "input_text", "text": "Hello"}]}],
  "tools": [],
  "tool_choice": "auto",
  "parallel_tool_calls": true,
  "store": false,
  "stream": true,
  "include": ["reasoning.encrypted_content"]
}
```

This is the Codex backend schema; `stream: true` matches its client, not the public Responses WebSocket guide.

Wait for `response.completed`, then send its `response.id` as `previous_response_id` with the next input. Example: `bun examples/codex-two-turns.ts '<model-slug>'`.

## Errors and state

Handshake failures retain upstream status, body and end-to-end headers. A 401 allows one refresh/reconnect on the same account before upgrade. After HTTP 101, errors, refusals and unknown events pass through without retries or account switching.

Frame and send-buffer limits are 32 MiB. Native Bun does not pause upstream reads: overflow closes the connection, normally with 1013. Treat that response as incomplete. Close codes/reasons are forwarded; ping/pong is handled separately on each connection.

Reconnect selects an account again. Session IDs do not restore the previous account or socket. Keep full history and handle `previous_response_not_found` and connection-limit errors. Delta-only replay after reconnect is unsafe.

Encrypted reasoning and compaction items pass through unchanged. Cross-account portability is not guaranteed. Codex has no local history/CAS, HTTP compaction endpoint or automatic context recovery.

## Quota and models

- `GET /codex/accounts`: account metadata without tokens.
- `GET /codex/usage?account=<local-id>`: account usage.
- `GET /codex/v1/models`: native catalog as `{models, errors}`.

Admission uses `rate_limit.allowed`, not rounded usage percentages. Unknown quota is unavailable. Usage is cached for 30 seconds, models for five minutes. Reset credits and reserve are never activated automatically.

Protocol reference: [openai/codex](https://github.com/openai/codex/tree/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs). Local mock tests cover transport and auth; live Codex login/inference has not been verified.
