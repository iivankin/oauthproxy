import { Accounts } from "./accounts.ts";
import { Accounts as CodexAccounts } from "./codex/accounts.ts";
import { AccountStore as CodexStore } from "./codex/store.ts";
import { Transport as CodexTransport } from "./codex/transport.ts";
import { codexHttp, upgrade, proxyError, upstreamError } from "./codex/proxy.ts";
import { NativeRelay } from "./codex/relay.ts";
import { MAX_PAYLOAD } from "./codex/websocket.ts";
import { streamResponses } from "./codex/sse.ts";
import { authorized, handler } from "./proxy.ts";
import { Stats } from "./stats.ts";
import { dashboard } from "./dashboard.ts";
import { AdminApi } from "./admin.ts";

export function serve(accounts: Accounts, hostname = "127.0.0.1", port = 3000, key?: string,
  codex = new CodexAccounts(new CodexStore(), new CodexTransport())) {
  if (!["127.0.0.1", "localhost", "::1"].includes(hostname) && !key)
    throw new Error("Set PROXY_API_KEY before binding a non-loopback interface");
  const stats = new Stats();
  const admin = new AdminApi(accounts, codex);
  const claude = handler(accounts, key, stats);
  const server = Bun.serve<NativeRelay>({
    hostname, port, idleTimeout: 0, maxRequestBodySize: MAX_PAYLOAD,
    async fetch(request, server) {
      const path = new URL(request.url).pathname;
      // Deliberately public; protect this route at the reverse proxy when exposing the server.
      if (path === "/dashboard" && request.method === "GET") return dashboard(accounts, codex, stats);
      if (path.startsWith("/admin/") && !key)
        return proxyError(503, "Set PROXY_API_KEY to enable admin routes");
      if (!authorized(request, key)) return proxyError(401, "Invalid proxy API key");
      if (request.headers.has("origin")) return proxyError(403, "Browser origins are not supported");
      try {
        if (path.startsWith("/admin/")) return await admin.handle(request);
        if (path === "/v1/responses") return request.method === "POST"
          ? await streamResponses(codex, request, stats) : await upgrade(codex, request, server, stats);
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
