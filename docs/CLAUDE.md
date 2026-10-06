# Claude API

## Requests

`POST /v1/messages` accepts Anthropic Messages JSON. Required fields: `model`, `max_tokens`, `messages`. Custom `system`, `tools`, thinking, compaction and other body fields are forwarded.

Headers:

- `Content-Type: application/json`.
- `Authorization: Bearer <PROXY_API_KEY>` or `x-api-key`, if configured.
- `x-claude-code-session-id: <session-id>`: reuse across turns. An explicit ID is required; alternative fields and routing are described in [Sessions](SESSIONS.md).
- `x-claude-code-prompt-id: <UUID>`: optional gateway hint; when supplied, it is also used by the billing metadata.
- `anthropic-usage-limit: extended|slow`: forwards Claude Code's server-controlled wrap-up or lower-priority mode.
- `anthropic-beta`: merged with body `betas` and the proxy's default flags.

The proxy uses `@anthropic-ai/sdk` with retries disabled. It adds the billing line to `system`, account/session metadata, and previous-message diagnostics. It does not inject an agent identity prompt, built-in tools, email context or title generation.

Without explicit cache settings, it adds one-hour cache markers to the custom system tail and last eligible message block. The billing line stays uncached. Explicit cache settings are preserved.

## Responses

JSON and SSE are supported. Preserve complete assistant content blocks, including tool calls, thinking signatures and compaction data. Return tool results using the original tool-use IDs.

For SSE, distinguish `message_stop` from `event: error` and an interrupted stream. HTTP 200 alone does not mean generation succeeded. Never append an incomplete response as a completed assistant turn. Closing the request cancels upstream.

Upstream status, error bodies, request IDs, retry/quota/refusal headers and unknown fields are preserved. Cookies and transport length/encoding headers are removed. The session ID is returned on forwarded responses.

## Routing and retries

The first request randomly selects an account with verified quota and model access. A durable `(provider, session, model)` binding pins later turns, including after a restart and compaction. The CAS separately supplies previous-message diagnostics. Confirmed quota exhaustion can switch the turn to another eligible account. Quota and models are cached for five minutes.

`extended` lets Anthropic decide whether an in-progress turn has a short grace window across its normal usage boundary. `slow` may cross the session limit but still requires weekly quota. Slow-lane `slot_busy` responses are returned to the client with their retry headers instead of rotating accounts.

The proxy retries only:

- Once after HTTP 401, following token refresh.
- On confirmed subscription quota exhaustion, using another eligible account.

`x-should-retry: false` disables retries. A generic 429, 5xx, refusal or SSE error does not trigger account switching. Quota detection requires HTTP 429, unified `rejected` status, a known exhausted window and no allowed overage. Each account is tried at most once before forwarding a response. Once SSE starts, its original errors are returned without replay. The proxy never enables paid extra usage.

Clients decide whether to retry other failures, respecting `Retry-After` / `retry-after-ms`. There is no request deduplication: retrying an ambiguous network failure may generate another response.

## History and compaction

Clients send the conversation history on every request. The proxy does not store or restore conversation text.

The local `.claude-proxy-cas/` maps account/session/history hashes to response IDs. Records use content-addressed JSON objects and refs, private permissions, checksums and atomic writes. Only completed responses are recorded. A disk failure warns and keeps the mapping in memory; crash recovery is then not guaranteed. CAS has no automatic cleanup.

Compaction blocks are forwarded unchanged. The last non-empty summary becomes the hash root, so removing the compacted prefix does not change the lookup key. Keep the required compaction beta and strategy on subsequent requests.

Account switches do not transfer previous-response IDs. Cross-account portability of encrypted thinking, signed compaction and server-side resources is not guaranteed. The proxy does not strip reasoning or repair rejected signatures. Use a single-account pool if account continuity is required.

## Other routes

- `GET /claude/v1/models`: combined catalog, not a quota guarantee.
- `GET /claude/accounts`: account metadata and usage, without tokens.
- `GET /health`: local server health only.

All routes use the same proxy key. Browser Origin requests are rejected. Files, batches and token-counting endpoints are not implemented.

## Remote login

With `PROXY_API_KEY` configured, `POST /admin/claude/oauth/start` with `{}` or `{"name":"label"}` returns a flow ID and authorization URL. After signing in, send the displayed `code#state` to `POST /admin/claude/oauth/complete` as `{"flowId":"...","code":"..."}`. The five-minute flow is in memory. The response contains safe account metadata; credentials stay in `accounts.json`.
