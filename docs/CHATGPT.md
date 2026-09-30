# ChatGPT plan sharing

This provider uses [Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source) and `api.openai.com`. Legacy Codex remains at `/v1/responses` with its own accounts.

## Accounts

```sh
bun run cli chatgpt accounts add --name personal
bun run cli chatgpt accounts list
bun run cli chatgpt accounts reauth <id>
bun run cli chatgpt models
```

The browser login uses a local `127.0.0.1` callback. For a remote server, sign in on your computer, copy `chatgpt-accounts.json` to the server, then run `bun run cli chatgpt accounts import <copied-file>` there. Import preserves the server's separate host ID. Stop using the source token session after transfer because refresh tokens rotate.

The dashboard also offers manual completion: open its authorization URL and paste the final `http://127.0.0.1:1455/auth/callback?...` browser URL into the callback field. The browser may show a connection error; the URL contains the one-use code. The admin API exposes the same two steps at `POST /admin/chatgpt/oauth/start` and `POST /admin/chatgpt/oauth/complete` (`{ "flowId": "...", "callbackUrl": "..." }`). Both require `PROXY_API_KEY`. A saved registration can be reauthorized by passing `accountId` to `/start`.

Each account keeps its issued `oaiapp_...` client ID, verified identity, rotating tokens, and granted scopes in `chatgpt-accounts.json`. The old `codex-accounts.json` is not read by this provider.

## Requests

Use `GET /chatgpt/v1/models` for available model slugs. HTTP requests go to `POST /chatgpt/v1/responses` with the proxy API key:

```json
{"model":"<available-model>","input":[{"role":"user","content":"Hello"}],"stream":true}
```

The proxy sets `store: false` and `stream: true`. Send the complete history in `input` on every HTTP turn; `previous_response_id` is rejected. It forwards SSE events and upstream errors. A confirmed `subscription_sharing_usage_limit_exceeded` temporarily removes that account from random selection; other 429 responses pass through without changing account selection.

`WS /chatgpt/v1/responses` selects one account for the connection and forwards Responses WebSocket events. Send `response.create` frames with an `input` array and `model`; the proxy sets `store: false`. WebSocket continuation can use `previous_response_id` only for responses created on that connection. See the [WebSocket protocol](https://developers.openai.com/api/docs/guides/websocket-mode).

The [preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) apply. In particular, do not send unsupported Responses fields or hosted tools. OpenAI does not document a numeric subscription-sharing usage API; `GET /chatgpt/usage` points to ChatGPT Settings → Usage instead.
