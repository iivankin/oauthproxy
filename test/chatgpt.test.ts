import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import WebSocket from "ws";
import { Accounts as ClaudeAccounts } from "../src/accounts.ts";
import { AccountStore as ClaudeStore } from "../src/store.ts";
import { Accounts as CodexAccounts } from "../src/codex/accounts.ts";
import { AccountStore as CodexStore } from "../src/codex/store.ts";
import { Transport as CodexTransport } from "../src/codex/transport.ts";
import { serve } from "../src/server.ts";
import { AdminApi } from "../src/admin.ts";
import { AccountStore } from "../src/chatgpt/store.ts";
import { Transport } from "../src/chatgpt/transport.ts";
import { begin, complete } from "../src/chatgpt/oauth.ts";
import { Accounts, SelectionError } from "../src/chatgpt/accounts.ts";
import { streamResponses } from "../src/chatgpt/proxy.ts";
import type { Endpoints } from "../src/chatgpt/types.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "chatgpt-sharing-test-"));
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...await exportJWK(publicKey), kid: "test-key", alg: "RS256", use: "sig" };
  const requests: { path: string; body: string; authorization: string | null }[] = [];
  const frames: string[] = [];
  const handshakes: (string | null)[] = [];
  let nonce = "", clientId = "oaiapp_test";
  let base = "";
  let status = 200;
  let responseBody = 'event: response.completed\ndata: {"type":"response.completed"}\n\n';
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request, server) {
    const path = new URL(request.url).pathname;
    if (path === "/responses" && request.headers.get("upgrade") === "websocket") {
      handshakes.push(request.headers.get("authorization"));
      server.upgrade(request);
      return;
    }
    const body = await request.text();
    requests.push({ path, body, authorization: request.headers.get("authorization") });
    if (path === "/jwks") return Response.json({ keys: [jwk] });
    if (path === "/models") return Response.json({ models: [{ slug: "shared-model", visibility: "list" }] });
    if (path === "/token") {
      const form = new URLSearchParams(body);
      const idToken = await new SignJWT({ nonce, email: "user@example.test" })
        .setProtectedHeader({ alg: "RS256", kid: "test-key" }).setIssuer(base)
        .setAudience(clientId).setSubject("subject-1").setIssuedAt().setExpirationTime("1h").sign(privateKey);
      return Response.json({ access_token: form.get("grant_type") === "refresh_token" ? "renewed" : "initial",
        refresh_token: "refresh-2", id_token: idToken, scope: "openid offline_access chatgpt.tokens.use.direct",
        expires_in: 3600 });
    }
    if (path === "/responses") return new Response(responseBody, { status,
      headers: { "content-type": status === 200 ? "text/event-stream" : "application/json", "x-request-id": "req_test" } });
    return new Response("Not found", { status: 404 });
  }, websocket: {
    message(client, message) { frames.push(message.toString()); client.send(message.toString()); },
  } });
  base = upstream.url.origin;
  const urls: Endpoints = { issuer: base, authorize: `${base}/authorize`, token: `${base}/token`,
    jwks: `${base}/jwks`, resource: `${base}/v1`, models: `${base}/models`,
    responses: `${base}/responses`, websocket: base.replace("http", "ws") + "/responses" };
  const store = new AccountStore(join(directory, "accounts.json"));
  const transport = new Transport(urls);
  const accounts = new Accounts(store, transport);
  cleanups.push(async () => { await upstream.stop(true); await rm(directory, { recursive: true, force: true }); });
  return { store, transport, accounts, requests, frames, handshakes, directory,
    setNonce(value: string) { nonce = value; }, setClientId(value: string) { clientId = value; },
    setResponse(next: number, body: string) { status = next; responseBody = body; } };
}

async function signedIn() {
  const f = await setup();
  const login = await begin(f.store, f.transport, 1455, "Personal");
  f.setNonce(login.nonce);
  const callback = `${login.redirectUri}?code=one-use&state=${login.state}&client_id=oaiapp_test`;
  const result = await complete(f.transport, login, callback);
  const account = await f.accounts.add(result.tokens, result.identity, result.clientId, login.name);
  return { ...f, login, callback, account };
}

test("dynamic OAuth verifies state, nonce, audience and signature before saving an issued client", async () => {
  const f = await setup();
  const login = await begin(f.store, f.transport, 1455);
  const auth = new URL(login.url);
  expect(auth.searchParams.get("client_id")).toBe("dynamic_agent_client");
  expect(auth.searchParams.get("ext_agent_host_id")).toBe((await f.store.read()).hostId);
  expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
  const callback = `${login.redirectUri}?code=one-use&state=${login.state}&client_id=oaiapp_test`;
  await expect(complete(f.transport, login, callback.replace(login.state, "wrong"))).rejects.toThrow("state");
  expect(f.requests.filter(request => request.path === "/token")).toHaveLength(0);
  f.setNonce("wrong");
  await expect(complete(f.transport, login, callback)).rejects.toThrow("nonce");
  f.setNonce(login.nonce);
  const result = await complete(f.transport, login, callback);
  expect(result.clientId).toBe("oaiapp_test");
  const exchange = new URLSearchParams(f.requests.find(request => request.path === "/token")!.body);
  expect(exchange.get("client_id")).toBe("oaiapp_test");
  expect(exchange.get("resource")).toBe(f.transport.urls.resource);
  expect(exchange.get("redirect_uri")).toBe(login.redirectUri);
  const account = await f.accounts.add(result.tokens, result.identity, result.clientId);
  expect((await f.accounts.status())[0]!.email).toBe("user@example.test");
  expect((await stat(f.store.path)).mode & 0o777).toBe(0o600);
  expect((await readFile(f.store.path, "utf8"))).toContain(account.clientId);
  const reauth = await begin(f.store, f.transport, 1456, undefined, (await f.store.read()).accounts[0]);
  expect(new URL(reauth.url).searchParams.get("client_id")).toBe("oaiapp_test");
  expect(new URL(reauth.url).searchParams.has("agent_name_hint")).toBe(false);
});

test("public Responses SSE forces stateless streaming, forwards errors, and cools only confirmed quota limits", async () => {
  const f = await signedIn();
  const request = (body: unknown) => new Request("http://localhost/chatgpt/v1/responses", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const payload = { model: "shared-model", input: [{ role: "user", content: "Hello" }], store: true };
  const response = await streamResponses(f.accounts, request(payload));
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("response.completed");
  const sent = JSON.parse(f.requests.find(item => item.path === "/responses")!.body);
  expect(sent).toMatchObject({ store: false, stream: true, input: payload.input });
  expect(f.requests.find(item => item.path === "/responses")!.authorization).toBe("Bearer initial");
  expect((await streamResponses(f.accounts, request({ ...payload, previous_response_id: "resp_old" }))).status).toBe(400);
  f.setResponse(429, JSON.stringify({ error: { code: "other_rate_limit" } }));
  expect((await streamResponses(f.accounts, request(payload))).status).toBe(429);
  expect(await f.accounts.choose("shared-model")).toBe(f.account.id);
  f.setResponse(429, JSON.stringify({ error: { code: "subscription_sharing_usage_limit_exceeded" } }));
  expect((await streamResponses(f.accounts, request(payload))).status).toBe(429);
  await expect(f.accounts.choose("shared-model")).rejects.toBeInstanceOf(SelectionError);
});

test("combined server exposes separate ChatGPT routes and pins a WebSocket to one OAuth account", async () => {
  const f = await signedIn();
  const claude = new ClaudeAccounts(new ClaudeStore(join(f.directory, "claude.json")));
  const codex = new CodexAccounts(new CodexStore(join(f.directory, "codex.json")), new CodexTransport());
  const proxy = serve(claude, "127.0.0.1", 0, "local-key", codex, f.accounts);
  cleanups.push(async () => { await proxy.stop(); });
  const base = proxy.url.toString();
  expect((await fetch(`${base}chatgpt/v1/models`, { headers: { authorization: "Bearer local-key" } })).status).toBe(200);
  expect((await fetch(`${base}chatgpt/v1/models`)).status).toBe(401);
  const socket = new WebSocket(`${base.replace("http", "ws")}chatgpt/v1/responses`, {
    headers: { authorization: "Bearer local-key" },
  });
  await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  const reply = new Promise<string>((resolve, reject) => {
    socket.once("message", data => resolve(data.toString())); socket.once("error", reject);
  });
  socket.send(JSON.stringify({ type: "response.create", model: "shared-model", input: [], stream: true, store: true }));
  expect(JSON.parse(await reply)).toMatchObject({ type: "response.create", model: "shared-model", store: false });
  expect(JSON.parse(f.frames[0]!).stream).toBeUndefined();
  expect(f.handshakes).toEqual(["Bearer initial"]);
  socket.close();
});

test("admin start and callback completion save credentials without returning secrets", async () => {
  const f = await setup();
  const admin = new AdminApi(new ClaudeAccounts(new ClaudeStore(join(f.directory, "claude.json"))),
    new CodexAccounts(new CodexStore(join(f.directory, "codex.json")), new CodexTransport()), f.accounts);
  const post = (path: string, body: unknown) => admin.handle(new Request(`http://localhost${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));
  const start = await (await post("/admin/chatgpt/oauth/start", { name: "Remote" })).json();
  const auth = new URL(start.authorizationUrl);
  f.setNonce(auth.searchParams.get("nonce")!);
  const callbackUrl = `${auth.searchParams.get("redirect_uri")}?code=one-use&state=${auth.searchParams.get("state")}&client_id=oaiapp_test`;
  const completion = await post("/admin/chatgpt/oauth/complete", { flowId: start.flowId, callbackUrl });
  expect(completion.status).toBe(200);
  const text = await completion.text();
  expect(text).toContain("Remote");
  for (const secret of ["initial", "refresh-2", "id_token", "accessToken", "refreshToken"])
    expect(text).not.toContain(secret);
  expect((await post("/admin/chatgpt/oauth/complete", { flowId: start.flowId, callbackUrl })).status).toBe(404);
  expect((await f.accounts.status())).toHaveLength(1);
});
