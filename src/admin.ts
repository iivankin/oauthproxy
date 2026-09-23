import { z } from "zod";
import type { Accounts } from "./accounts.ts";
import type { Accounts as CodexAccounts } from "./codex/accounts.ts";
import { createLogin, validateCode } from "./oauth.ts";
import { OAUTH } from "./transport.ts";
import { finishDeviceLogin, startDeviceLogin, type DeviceLogin } from "./codex/oauth.ts";

const nameSchema = z.object({ name: z.string().trim().min(1).max(100).optional() }).strict();
const completeSchema = z.object({ flowId: z.uuid(), code: z.string().min(1).max(4096) }).strict();
type SafeAccount = Record<string, unknown>;
type ClaudeFlow = { provider: "claude"; status: "pending"; expiresAt: number; name?: string;
  verifier: string; state: string; redirectUri: string; authorizationUrl: string };
type CodexFlow = { provider: "codex"; status: "pending" | "completed" | "failed"; expiresAt: number;
  verificationUrl: string; userCode: string; device: DeviceLogin; account?: SafeAccount; error?: string };
type Flow = ClaudeFlow | CodexFlow;

function jsonError(status: number, message: string) {
  return Response.json({ error: { type: "admin_error", message } },
    { status, headers: { "cache-control": "no-store" } });
}

async function body<T>(request: Request, schema: z.ZodType<T>) {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json"))
    throw new Error("Content-Type must be application/json");
  let value: unknown;
  try { value = await request.json(); } catch { throw new Error("Invalid JSON"); }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error("Invalid request body");
  return parsed.data;
}

export class AdminApi {
  private readonly flows = new Map<string, Flow>();
  constructor(private readonly claude: Accounts, private readonly codex: CodexAccounts) {}

  private save(id: string, flow: Flow) {
    this.flows.set(id, flow);
    const timer = setTimeout(() => this.flows.delete(id), Math.max(1, flow.expiresAt - Date.now()) + 300_000);
    timer.unref();
  }

  private publicFlow(id: string, flow: Flow) {
    const common = { flowId: id, provider: flow.provider, status: flow.status,
      expiresAt: new Date(flow.expiresAt).toISOString() };
    if (flow.provider === "claude") return common;
    return { ...common, verificationUrl: flow.verificationUrl, userCode: flow.userCode,
      ...(flow.account && { account: flow.account }), ...(flow.error && { error: flow.error }) };
  }

  async handle(request: Request) {
    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/admin/claude/oauth/start") {
        const input = await body(request, nameSchema);
        const login = createLogin(OAUTH.manualRedirect);
        const id = crypto.randomUUID();
        const expiresAt = Date.now() + 5 * 60_000;
        this.save(id, { provider: "claude", status: "pending", expiresAt, name: input.name,
          verifier: login.verifier, state: login.state, redirectUri: login.redirectUri,
          authorizationUrl: login.url });
        return Response.json({ flowId: id, provider: "claude", status: "pending",
          authorizationUrl: login.url, expiresAt: new Date(expiresAt).toISOString() },
        { status: 201, headers: { "cache-control": "no-store" } });
      }
      if (request.method === "POST" && url.pathname === "/admin/claude/oauth/complete") {
        const input = await body(request, completeSchema);
        const flow = this.flows.get(input.flowId);
        if (!flow || flow.provider !== "claude") return jsonError(404, "OAuth flow not found");
        if (flow.expiresAt <= Date.now()) { this.flows.delete(input.flowId); return jsonError(410, "OAuth flow expired"); }
        const code = validateCode(input.code, null, flow.state);
        this.flows.delete(input.flowId); // Authorization codes are one-use, even if the exchange outcome is ambiguous.
        const tokens = await this.claude.transport.tokenRequest({ grant_type: "authorization_code", code,
          redirect_uri: flow.redirectUri, client_id: OAUTH.clientId, code_verifier: flow.verifier, state: flow.state });
        return Response.json({ flowId: input.flowId, provider: "claude", status: "completed",
          account: await this.claude.add(tokens, flow.name) }, { headers: { "cache-control": "no-store" } });
      }
      if (request.method === "POST" && url.pathname === "/admin/codex/oauth/start") {
        const input = await body(request, nameSchema);
        const device = await startDeviceLogin(this.codex.transport);
        const id = crypto.randomUUID();
        const expiresAt = Date.now() + 15 * 60_000;
        const flow: CodexFlow = { provider: "codex", status: "pending", expiresAt,
          verificationUrl: device.verificationUrl, userCode: device.userCode, device };
        this.save(id, flow);
        void finishDeviceLogin(this.codex.transport, device, AbortSignal.timeout(15 * 60_000))
          .then(tokens => this.codex.add(tokens, input.name))
          .then(account => { flow.status = "completed"; flow.account = account; })
          .catch(() => { flow.status = "failed"; flow.error = "OAuth login failed or expired"; });
        return Response.json(this.publicFlow(id, flow), { status: 201, headers: { "cache-control": "no-store" } });
      }
      const match = request.method === "GET" && url.pathname.match(/^\/admin\/oauth\/([0-9a-f-]{36})$/i);
      if (match) {
        const flow = this.flows.get(match[1]!);
        if (!flow) return jsonError(404, "OAuth flow not found");
        if (flow.status === "pending" && flow.expiresAt <= Date.now()) return jsonError(410, "OAuth flow expired");
        return Response.json(this.publicFlow(match[1]!, flow), { headers: { "cache-control": "no-store" } });
      }
      return jsonError(404, "Not found");
    } catch (error) {
      if (error instanceof Error && ["Content-Type must be application/json", "Invalid JSON", "Invalid request body",
        "OAuth state mismatch or missing authorization code", "Conflicting OAuth state"].includes(error.message))
        return jsonError(400, error.message);
      console.warn("Admin OAuth operation failed");
      return jsonError(502, "OAuth operation failed");
    }
  }
}
