import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { OAUTH, Transport } from "./transport.ts";

export function createLogin(redirectUri: string) {
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const url = new URL(OAUTH.authorize);
  url.search = new URLSearchParams({ code: "true", client_id: OAUTH.clientId, response_type: "code",
    redirect_uri: redirectUri, scope: OAUTH.scopes.join(" "), code_challenge: challenge,
    code_challenge_method: "S256", state }).toString();
  return { verifier, state, redirectUri, url: url.toString() };
}

export function validateCode(raw: string, receivedState: string | null, expectedState: string) {
  const [code, fragment] = raw.trim().split("#");
  const state = fragment ?? receivedState ?? "";
  const expected = Buffer.from(expectedState);
  const actual = Buffer.from(state);
  if (!code || actual.length !== expected.length || !timingSafeEqual(actual, expected))
    throw new Error("OAuth state mismatch or missing authorization code");
  if (fragment && receivedState && fragment !== receivedState) throw new Error("Conflicting OAuth state");
  return code;
}

async function openBrowser(url: string) {
  const commands: Record<string, string[]> = { darwin: ["open", url], linux: ["xdg-open", url], win32: ["rundll32", "url.dll,FileProtocolHandler", url] };
  const command = commands[process.platform];
  if (command) {
    try { await Bun.spawn(command, { stdout: "ignore", stderr: "ignore" }).exited; }
    catch { /* The printed link remains usable on headless machines. */ }
  }
}

export async function login(transport: Transport, manual = false) {
  let loginData: ReturnType<typeof createLogin>;
  let code: string;
  if (manual) {
    loginData = createLogin(OAUTH.manualRedirect);
    console.log(`Open this URL and sign in:\n${loginData.url}`);
    const reader = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const raw = await reader.question("Paste code#state: ", { signal: AbortSignal.timeout(300_000) });
      code = validateCode(raw, null, loginData.state);
    } finally { reader.close(); }
  } else {
    const pending = Promise.withResolvers<string>();
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      const url = new URL(request.url);
      if (request.method !== "GET" || url.pathname !== "/callback") return new Response("Not found", { status: 404 });
      try {
        const code = validateCode(url.searchParams.get("code") ?? "", url.searchParams.get("state"), loginData.state);
        pending.resolve(code);
        return new Response("Signed in. You can close this tab.", { headers: { "content-type": "text/plain", "cache-control": "no-store" } });
      } catch { return new Response("Invalid OAuth callback", { status: 400 }); }
    } });
    loginData = createLogin(`http://localhost:${server.port}/callback`);
    console.log(`Open this URL and sign in:\n${loginData.url}`);
    const timer = setTimeout(() => pending.reject(new Error("Login timed out after 5 minutes")), 300_000);
    void openBrowser(loginData.url);
    try { code = await pending.promise; }
    finally { clearTimeout(timer); await server.stop(true); }
  }
  return transport.tokenRequest({ grant_type: "authorization_code", code, redirect_uri: loginData.redirectUri,
    client_id: OAUTH.clientId, code_verifier: loginData.verifier, state: loginData.state });
}
