import { gunzipSync } from "node:zlib";
import { AppError, messageSchema, type Message } from "./schema.ts";

const MAX_BODY = 32 * 1024 * 1024;

export type NativeMessage = { body: Uint8Array<ArrayBuffer>; headers: Headers; search: string };
type Submission = { model: string; payload: unknown } & (
  { kind: "cli"; wire: NativeMessage } | { kind: "sdk"; input: Message }
);

export function isClaudeCode(headers: Headers) {
  const agent = headers.get("user-agent") ?? "";
  return /^claude-cli\/\S+(?:\s|$)/i.test(agent) && !/agent-sdk\/|\bsdk-(?:ts|py)\b/i.test(agent);
}

export async function readMessage(request: Request): Promise<Submission> {
  const body = new Uint8Array(await request.arrayBuffer());
  if (body.byteLength > MAX_BODY) throw new AppError(413, "Messages request exceeds 32 MiB");
  const encoding = request.headers.get("content-encoding")?.trim().toLowerCase();
  if (encoding && encoding !== "identity" && encoding !== "gzip")
    throw new AppError(415, "Unsupported Content-Encoding");
  let payload: unknown;
  try {
    // Decode only a bounded routing copy. Native CLI bytes, including gzip, are never reserialized.
    const json = encoding === "gzip" ? gunzipSync(body, { maxOutputLength: MAX_BODY }) : body;
    payload = JSON.parse(new TextDecoder().decode(json));
  } catch { throw new AppError(400, "Invalid JSON or gzip Messages request"); }
  if (isClaudeCode(request.headers)) {
    const model = typeof payload === "object" && payload !== null && "model" in payload ? payload.model : undefined;
    if (typeof model !== "string" || !model.length) throw new AppError(400, "Invalid Messages request: model must be a nonempty string");
    // Upstream validates native API fields; routing must not reject new roles or beta payloads.
    return { kind: "cli", model, payload, wire: { body, headers: request.headers, search: new URL(request.url).search } };
  }
  const input = messageSchema.safeParse(payload);
  if (!input.success) {
    const issue = input.error.issues[0]!;
    throw new AppError(400, `Invalid Messages request: ${issue.path.join(".") || "body"}: ${issue.message}`);
  }
  return { kind: "sdk", model: input.data.model, payload, input: input.data };
}

export function endToEndHeaders(source: Headers) {
  const headers = new Headers(source);
  const nominated = (headers.get("connection") ?? "").split(",").map(name => name.trim()).filter(Boolean);
  for (const name of ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer",
    "transfer-encoding", "upgrade", ...nominated]) headers.delete(name);
  return headers;
}

export function nativeHeaders(source: Headers, token: string) {
  const headers = endToEndHeaders(source);
  // Authority/framing belong to the new HTTP leg; never leak the proxy credential upstream.
  for (const name of ["host", "content-length", "x-api-key", "authorization"]) headers.delete(name);
  headers.set("authorization", `Bearer ${token}`);
  return headers;
}
