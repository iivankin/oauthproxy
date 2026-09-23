# Claude API

## Requests

`POST /v1/messages` accepts Anthropic Messages JSON. Required fields: `model`, `max_tokens`, `messages`. Custom `system`, `tools`, thinking, compaction and other body fields are forwarded.

Headers:

- `Content-Type: application/json`.
- `Authorization: Bearer <PROXY_API_KEY>` or `x-api-key`, if configured.
- `x-claude-code-session-id: <UUID>`: reuse across turns. If missing, the proxy warns, generates one and returns it.
- `anthropic-beta`: merged with body `betas` and the proxy's default flags.

The proxy uses `@anthropic-ai/sdk` with retries disabled. It adds the Agent SDK identity and billing line to `system`, account/session metadata, and previous-message diagnostics. It does not add built-in tools, email context or title generation.

Without explicit cache settings, it adds one-hour cache markers to the SDK identity, custom system tail and last eligible message block. Explicit cache settings are preserved.

## Responses

JSON and SSE are supported. Preserve complete assistant content blocks, including tool calls, thinking signatures and compaction data. Return tool results using the original tool-use IDs.

For SSE, distinguish `message_stop` from `event: error` and an interrupted stream. HTTP 200 alone does not mean generation succeeded. Never append an incomplete response as a completed assistant turn. Closing the request cancels upstream.

Upstream status, error bodies, request IDs, retry/quota/refusal headers and unknown fields are preserved. Cookies and transport length/encoding headers are removed. The session ID is returned on forwarded responses.

## Routing and retries

Each request randomly selects an account with verified quota and model access. A session ID does **not** pin an account. Quota is cached for 30 seconds; models for five minutes.

The proxy retries only:

- Once after HTTP 401, following token refresh.
- On confirmed subscription quota exhaustion, using another eligible account.

`x-should-retry: false` disables retries. A generic 429, 5xx, refusal or SSE error does not trigger account switching. Quota detection requires HTTP 429, unified `rejected` status, a known exhausted window and no allowed overage. The proxy never enables paid extra usage.

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
