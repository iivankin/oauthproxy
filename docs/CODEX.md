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

For remote management, with `PROXY_API_KEY` configured, `POST /admin/codex/oauth/start` with `{}` or `{"name":"label"}` returns a flow ID, verification URL and user code. Poll `GET /admin/oauth/<flow-id>` until `completed` or `failed`. The flow is in memory; credentials stay in `codex-accounts.json` and are never returned.

Credentials are stored in `codex-accounts.json` in cwd, with `0600` permissions, atomic writes and a cross-process lock. The installed Codex's credentials are not touched. Tokens refresh before expiry, every 30 seconds in the background, or once after HTTP 401. Invalid refresh tokens disable the account until login.

## WebSocket

`WS /v1/responses` forwards to `wss://chatgpt.com/backend-api/codex/responses`.

- Authenticate with `Authorization: Bearer <PROXY_API_KEY>` or `x-api-key`.
- `session-id` or another supported ID header is optional for WS; absent headers get a connection transport ID. HTTP requires an explicit ID; see [Sessions](SESSIONS.md).
- Optional `thread-id` and `x-client-request-id` default to the session ID.
- Each `response.create` carries its own model, so one connection may use different models.
- Upstream connects during the handshake, before any frame, allowing warmup. URL model hints are not used.

One upstream connection keeps one account, independent of logical session/model/stream IDs. HTTP uses separate durable session/model bindings. Browser Origin and WebSocket subprotocols are rejected.

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

## HTTP / SSE

`POST /v1/responses` forwards directly to `https://chatgpt.com/backend-api/codex/responses`, without a WebSocket bridge. Send `Content-Type: application/json` and the same body as above **without `type`**. `model`, `input` and `stream: true` are required; non-streaming JSON mode is not implemented. Auth/session headers are the same; the WebSocket beta header is not sent.

Each HTTP request uses the durable session/model binding while its account remains eligible. Send full context each time: affinity does not restore WebSocket response state. The request body and SSE bytes are forwarded unchanged, including opaque reasoning, compaction and unknown events.

HTTP errors retain status/body/retry headers. HTTP 401 triggers one refresh/retry on the same account. Confirmed quota exhaustion can transparently retry full input without `previous_response_id` before any bytes are forwarded, once per account. Generic 429, 5xx, refusals and errors after streaming starts are not replayed. Canceling the client request cancels upstream. Require a terminal event; HTTP 200 or EOF alone does not prove success. Maximum request body: 32 MiB; upstream request timeout: 10 minutes.

## Errors and state

Initial handshake failures retain upstream HTTP status, body and headers. A 401 allows one refresh/reconnect on the same account. Confirmed `usage_limit_reached` marks the account unavailable; ordinary 429 errors do not. Only confirmed exhaustion allows replacing upstream inside the live client socket and replaying a sole unstarted full-input create; see [Sessions](SESSIONS.md). Other errors, refusals and unknown events pass through.

Frame and send-buffer limits are 32 MiB. Native Bun does not pause upstream reads: overflow closes the connection, normally with 1013. Treat that response as incomplete. Close codes/reasons are forwarded; ping/pong is handled separately on each connection.

Reconnect selects an account afresh. After quota exhaustion, full input without an old `previous_response_id` allows continuation on a different account. Old IDs are passed unchanged and may receive the upstream's `previous_response_not_found`. Keep full histories and handle incomplete responses and connection-limit errors. No custom recovery error codes are required.

Encrypted reasoning and compaction items pass through unchanged. Cross-account portability is not guaranteed. Codex has no local history/CAS, HTTP compaction endpoint or automatic context recovery.

## Quota and models

- `GET /codex/accounts`: account metadata without tokens.
- `GET /codex/usage?account=<local-id>`: account usage.
- `GET /codex/v1/models`: native catalog as `{models, errors}`.

Admission uses `rate_limit.allowed`, not rounded usage percentages. Unknown quota is unavailable. Usage is cached for 30 seconds, models for five minutes. Reset credits and reserve are never activated automatically.

Protocol reference: [openai/codex](https://github.com/openai/codex/tree/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs). Local mock tests cover transport and auth; live Codex login/inference has not been verified.
