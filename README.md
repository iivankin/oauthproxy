# OAuth Proxy

One Bun server for Claude and Codex, with multi-account OAuth, token refresh, quota checks, and random eligible-account selection.

- `POST /v1/messages` — Claude JSON/SSE.
- `WS /v1/responses` — Codex WebSocket forwarding; one account per connection.
- Provider models and accounts: `/claude/v1/models`, `/codex/v1/models`, `/claude/accounts`, `/codex/accounts`.

## Quick start

Requires Bun 1.4.0 or later.

```sh
bun install --frozen-lockfile
bun run cli claude accounts add --name personal
bun run cli codex accounts add --name personal
PROXY_API_KEY='your-local-secret' bun start
```

Only add accounts for the providers you use. The server listens on `127.0.0.1:3000`. Authenticate with `Authorization: Bearer <PROXY_API_KEY>` or `x-api-key`.

Credentials are stored unencrypted with `0600` permissions in `accounts.json` and `codex-accounts.json` in the working directory. Keep them private. Use a TLS reverse proxy for remote access.

## Development

```sh
bun run check
bun test
bun run build
```

Client contracts and limitations: [Claude](docs/CLAUDE.md) · [Codex](docs/CODEX.md).
