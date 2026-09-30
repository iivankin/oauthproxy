import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { AccountStore } from "./store.ts";
import { Transport } from "./transport.ts";
import type { Account, Tokens } from "./types.ts";
import { scopes } from "./types.ts";

export type Login = {
  url: string; state: string; nonce: string; verifier: string; redirectUri: string;
  clientId?: string; previous?: Account; name?: string;
};
export type Identity = { subject: string; email?: string };
const random = () => randomBytes(32).toString("base64url");
const keys = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export async function begin(store: AccountStore, transport: Transport, port: number, name?: string, previous?: Account): Promise<Login> {
  const hostId = await store.hostId();
  const state = random(), nonce = random(), verifier = random();
  const redirectUri = `http://127.0.0.1:${port}/auth/callback`;
  const url = new URL(transport.urls.authorize);
  const params = url.searchParams;
  params.set("client_id", previous?.clientId ?? "dynamic_agent_client");
  if (!previous) params.set("agent_name_hint", "OAuth Proxy");
  else {
    if (previous.email) params.set("login_hint", previous.email);
  }
  params.set("ext_agent_host_id", hostId);
  params.set("response_type", "code");
  params.set("redirect_uri", redirectUri);
  params.set("scope", scopes);
  params.set("resource", transport.urls.resource);
  params.set("state", state);
  params.set("nonce", nonce);
  params.set("code_challenge_method", "S256");
  params.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
  return { url: url.toString(), state, nonce, verifier, redirectUri, clientId: previous?.clientId, previous, name };
}

export function callbackCode(login: Login, callback: string) {
  let url: URL;
  try { url = new URL(callback); } catch { throw new Error("Paste the full callback URL"); }
  const expected = new URL(login.redirectUri);
  if (url.origin !== expected.origin || url.pathname !== expected.pathname || url.hash)
    throw new Error("OAuth callback URL does not match this login");
  if (url.searchParams.get("state") !== login.state) throw new Error("OAuth state mismatch");
  if (url.searchParams.has("error")) throw new Error(`OAuth denied: ${url.searchParams.get("error")}`);
  const code = url.searchParams.get("code");
  if (!code) throw new Error("OAuth callback has no code");
  const returnedClient = url.searchParams.get("client_id");
  const clientId = login.clientId ?? returnedClient;
  if (!clientId?.startsWith("oaiapp_") || (returnedClient && returnedClient !== clientId))
    throw new Error("OAuth callback has no matching issued client ID");
  return { code, clientId };
}

export async function complete(transport: Transport, login: Login, callback: string): Promise<{
  tokens: Tokens; identity: Identity; clientId: string;
}> {
  const { code, clientId } = callbackCode(login, callback);
  const tokens = await transport.exchange(clientId, code, login.verifier, login.redirectUri);
  if (!tokens.id_token) throw new Error("OAuth exchange has no ID token");
  const jwks = keys.get(transport.urls.jwks) ?? createRemoteJWKSet(new URL(transport.urls.jwks));
  keys.set(transport.urls.jwks, jwks);
  const { payload } = await jwtVerify(tokens.id_token, jwks, {
    issuer: transport.urls.issuer, audience: clientId, algorithms: ["RS256"],
    requiredClaims: ["sub", "exp", "iat", "nonce"], clockTolerance: 5,
  });
  if (payload.nonce !== login.nonce || typeof payload.sub !== "string" || !payload.sub)
    throw new Error("OAuth ID token identity or nonce mismatch");
  if (login.previous && (login.previous.subject !== payload.sub || login.previous.clientId !== clientId))
    throw new Error("OAuth account identity changed");
  if (!tokens.scope?.split(" ").includes("chatgpt.tokens.use.direct"))
    throw new Error("ChatGPT plan usage was not authorized");
  return { tokens, identity: { subject: payload.sub, email: typeof payload.email === "string" ? payload.email : undefined }, clientId };
}

export async function localLogin(store: AccountStore, transport: Transport, name?: string, previous?: Account) {
  const result = Promise.withResolvers<string>();
  const timeout = setTimeout(() => result.reject(new Error("OAuth login expired")), 15 * 60_000);
  const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== "/auth/callback") return new Response("Not found", { status: 404 });
    result.resolve(request.url);
    return new Response("Sign-in received. Return to the terminal.", { headers: { "content-type": "text/plain" } });
  } });
  try {
    if (!listener.port) throw new Error("OAuth callback listener has no port");
    const login = await begin(store, transport, listener.port, name, previous);
    console.log(`Open this URL to sign in:\n${login.url}`);
    const callback = await result.promise;
    return { login, result: await complete(transport, login, callback) };
  } finally { clearTimeout(timeout); await listener.stop(true); }
}
