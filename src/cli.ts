import { parseArgs } from "node:util";
import { Accounts } from "./accounts.ts";
import { login } from "./oauth.ts";
import { serve } from "./server.ts";
import { safeAccount, tokensSchema } from "./schema.ts";
import { Accounts as CodexAccounts } from "./codex/accounts.ts";
import { AccountStore as CodexStore } from "./codex/store.ts";
import { Transport as CodexTransport } from "./codex/transport.ts";
import { deviceLogin } from "./codex/oauth.ts";

const help = `Usage: bun src/cli.ts <command>
  claude accounts add [--name label] [--manual]   Browser OAuth + PKCE
  codex accounts add [--name label]              Device-code OAuth
  <claude|codex> accounts list                   List accounts (no secrets)
  <claude|codex> accounts usage                  Fetch current quota
  <claude|codex> accounts refresh [id]            Force token refresh
  claude accounts import <tokens.json>           Import camelCase token JSON
  <claude|codex> models [id]                      Available models
  serve [--host 127.0.0.1] [--port 3000]          Combined HTTP + WebSocket server

Credentials: ./accounts.json (Claude), ./codex-accounts.json (Codex).
Claude history CAS: ./.claude-proxy-cas. All paths relative to cwd.
Optional env: PROXY_API_KEY.
`;

async function main() {
  const { positionals, values } = parseArgs({ args: Bun.argv.slice(2), allowPositionals: true,
    options: { name: { type: "string" }, manual: { type: "boolean" }, host: { type: "string" }, port: { type: "string" }, help: { type: "boolean", short: "h" } } });
  const [provider, command, action, argument] = positionals;
  if (values.help || !provider) { console.log(help); return; }
  const accounts = new Accounts();
  const codex = new CodexAccounts(new CodexStore(), new CodexTransport());
  const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
  if (provider === "serve") {
    const port = Number(values.port ?? "3000");
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid port");
    const server = serve(accounts, values.host, port, process.env.PROXY_API_KEY, codex);
    const stopRefresh = accounts.startRefresh();
    const stopCodexRefresh = codex.startRefresh();
    console.log(`Listening on ${server.url}\nClaude: ${accounts.store.path}\nCodex: ${codex.store.path}`);
    const stop = async () => { stopRefresh(); stopCodexRefresh(); await server.stop(); process.exit(0); };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    return;
  }
  if (provider === "codex") {
    if (values.manual) throw new Error("Codex uses device-code login; --manual applies only to Claude");
    if (command === "models") { print(action ? await codex.models(action, true) : await codex.catalog()); return; }
    if (command !== "accounts") throw new Error(help);
    switch (action) {
      case "add": print(await codex.add(await deviceLogin(codex.transport), values.name)); return;
      case "list": print(await codex.status()); return;
      case "usage": {
        for (const account of await codex.status()) {
          try { print({ ...account, usage: await codex.usage(account.id, true) }); }
          catch { print({ ...account, error: "Usage unavailable" }); }
        }
        return;
      }
      case "refresh": {
        const selected = (await codex.store.read()).accounts.filter(account => !argument || account.id === argument);
        if (!selected.length) throw new Error("No matching accounts");
        for (const account of selected) await codex.token(account.id, account.accessToken);
        print((await codex.status()).filter(account => !argument || account.id === argument));
        return;
      }
      default: throw new Error(help);
    }
  }
  if (provider !== "claude") throw new Error(help);
  if (command === "models") { print(action ? await accounts.models(action) : await accounts.allModels()); return; }
  if (command !== "accounts") throw new Error(help);
  switch (action) {
    case "add": print(await accounts.add(await login(accounts.transport, values.manual), values.name)); return;
    case "list": print((await accounts.store.read()).accounts.map(safeAccount)); return;
    case "usage": print(await accounts.status(true)); return;
    case "import": {
      if (!argument) throw new Error("Pass a token JSON file");
      let tokens;
      try { tokens = tokensSchema.parse(await Bun.file(argument).json()); }
      catch { throw new Error("Invalid token JSON: need accessToken, expiresAt (epoch ms), optional refreshToken/scopes/clientId"); }
      print(await accounts.add(tokens, values.name)); return;
    }
    case "refresh": {
      const selected = (await accounts.store.read()).accounts.filter(account => !argument || account.id === argument);
      if (!selected.length) throw new Error("No matching accounts");
      for (const account of selected) print(safeAccount(await accounts.token(account.id, account.accessToken)));
      return;
    }
    default: throw new Error(help);
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : "Command failed");
  process.exitCode = 1;
});
