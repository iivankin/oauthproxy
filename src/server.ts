import { Accounts } from "./accounts.ts";
import { Accounts as CodexAccounts } from "./codex/accounts.ts";
import { AccountStore as CodexStore } from "./codex/store.ts";
import { Transport as CodexTransport } from "./codex/transport.ts";
import { codexHttp, upgrade, proxyError, upstreamError } from "./codex/proxy.ts";
import { NativeRelay } from "./codex/relay.ts";
import { MAX_PAYLOAD } from "./codex/websocket.ts";
import { authorized, handler } from "./proxy.ts";

export function serve(accounts: Accounts, hostname = "127.0.0.1", port = 3000, key?: string,
  codex = new CodexAccounts(new CodexStore(), new CodexTransport())) {
  if (!["127.0.0.1", "localhost", "::1"].includes(hostname) && !key)
    throw new Error("Set PROXY_API_KEY before binding a non-loopback interface");
  const claude = handler(accounts, key);
  const server = Bun.serve<NativeRelay>({
    hostname, port, idleTimeout: 0, maxRequestBodySize: MAX_PAYLOAD,
    async fetch(request, server) {
      if (!authorized(request, key)) return proxyError(401, "Invalid proxy API key");
      if (request.headers.has("origin")) return proxyError(403, "Browser origins are not supported");
      const path = new URL(request.url).pathname;
      try {
        if (path === "/v1/responses") return await upgrade(codex, request, server);
        if (path.startsWith("/codex/")) return await codexHttp(codex, request);
        return claude(request);
      } catch (error) { return upstreamError(error); }
    },
    websocket: {
      maxPayloadLength: MAX_PAYLOAD, backpressureLimit: MAX_PAYLOAD, closeOnBackpressureLimit: true,
      idleTimeout: 0, perMessageDeflate: false,
      open(client) { client.data.attach(client); },
      message(client, message) { client.data.send(message); },
      close(client, code, reason) { client.data.close(code, reason); },
    },
  });
  return { url: server.url, stop: () => server.stop(true) };
}
