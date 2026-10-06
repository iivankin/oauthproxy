# Sessions

HTTP inference requires an explicit session ID. Reuse it across turns. Requests without a valid ID return 400. IDs must be non-empty, at most 256 UTF-8 bytes, without control characters. No generated HTTP IDs or history-based guesses. WebSocket account affinity is connection-based instead.

Extraction priority follows CLIProxyAPI's explicit client signals:

1. `x-claude-code-session-id`, then the session embedded in Claude `metadata.user_id` (JSON string or legacy `_session_...` suffix).
2. Codex `session-id` / `session_id`, or session/thread fields in `x-codex-turn-metadata`; `thread-id` / `thread_id` is the thread fallback.
3. `x-http-session-id`, `x-session-id`, `x-session-affinity`, `x-slot-session-id`, task/conversation/thread headers, `x-client-request-id`.
4. Body cache/thread IDs, `session_id` / `sessionId` (also `metadata` and `extra_body`), task/action IDs.
5. `prompt_cache_key`, `conversation.id` or string `conversation`, plain `metadata.user_id`, legacy conversation/chat IDs.

The same raw ID identifies the session regardless of which supported field carries it. HTTP responses echo it as `session-id` (Codex/ChatGPT) or `x-claude-code-session-id` (Claude). A per-request ID that changes every turn does not provide conversation affinity.

Bindings use `(provider, session ID, model) → account ID`. The first request selects an eligible account. Later requests keep it until quota exhaustion, account disablement/removal or loss of model access. A failed quota/model check does not silently rotate a bound account. Ordinary request errors do not clear bindings. Confirmed quota rejection can retry a self-contained request before response bytes are sent; each account is tried at most once. Late errors and exhaustion of the whole pool retain the upstream error. Claude retains its HTTP quota retry behavior.

`.session-bindings/` beside each account store contains hashed-filename JSON records, atomically written with private permissions. Bindings have no TTL and survive restarts. The directory is owned by one running server process; selection is serialized per binding within that server. Disk-write failures warn and retain the binding in memory. There is no automatic cleanup. No tokens or conversation content are stored here.

## WebSocket

The connection itself owns account affinity. A logical session ID is optional. The proxy selects an eligible account and opens upstream before HTTP 101, allowing warmup without a create frame. Any number of logical session IDs, model names and `stream_id` values can share the connection without changing its account. They do not consult or modify HTTP bindings. A generated connection ID supplies transport headers when none was provided; it is not a durable conversation binding. Reconnect selects an account afresh.

Only confirmed quota exhaustion permits upstream replacement. A sole unstarted `response.create` with full `input` and no `previous_response_id` is retried transparently, preserving its bytes and `stream_id`. Each account is tried at most once. Concurrent generations, requests with a previous ID, and partially delivered responses are not replayed. Their original upstream error reaches the client. The client WS stays open even if that exhausted upstream closes; the next request opens another eligible account's upstream.

Initial upstream handshake failures remain HTTP errors. Failures while opening a replacement arrive as WS error events with status, error details and response headers, then close. Ordinary 429s, request errors and model changes do not rotate accounts. A non-quota upstream disconnect still closes the client.

Upstream socket state and response IDs are not transferred to another account. `previous_response_id` is forwarded unchanged even after replacement; any resulting `previous_response_not_found` is returned unchanged. No custom history-required error or automatic history reconstruction is used. Clients retain full history and handle incomplete responses. Other in-flight work on the exhausted upstream is not replayed. Encrypted reasoning portability is not guaranteed.
