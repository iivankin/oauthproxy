import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transport, type Fetch } from "../src/transport.ts";
import { HistoryStore } from "../src/history-store.ts";
import { accountSchema, type Message } from "../src/schema.ts";

const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
const account = accountSchema.parse({ id: "a", accountUuid: crypto.randomUUID(), deviceId: "a".repeat(64), name: "test",
  email: "test@example.invalid", organizationId: "org", accessToken: "test", expiresAt: Date.now() + 3600000 });
const first: Message = { model: "claude-opus-4-6", max_tokens: 512, messages: [{ role: "user", content: "Remember blue." }] };
const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
function streamed(id: string, content: Record<string, unknown>[], reason: string) {
  return sse("message_start", { type: "message_start", message: { id, type: "message", role: "assistant", model: first.model,
    content: [], usage: { input_tokens: 10, output_tokens: 0 }, stop_reason: null, stop_sequence: null } })
    + content.map((block, index) => sse("content_block_start", { type: "content_block_start", index, content_block: block })
      + sse("content_block_stop", { type: "content_block_stop", index })).join("")
    + sse("message_delta", { type: "message_delta", delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: 5 } })
    + sse("message_stop", { type: "message_stop" });
}

test("threshold and signed on-demand compaction round-trip through transport, survive restart and full/trimmed histories", async () => {
  for (const mode of ["threshold", "on-demand"]) for (const streaming of [false, true]) {
    const directory = await mkdtemp(join(tmpdir(), "claude-history-transport-"));
    directories.push(directory);
    const summary = mode === "threshold"
      ? { type: "compaction", content: "User chose blue.", encrypted_content: "opaque-unchanged" }
      : { type: "compaction", content: "User chose blue.", signature: "signed-unchanged" };
    const content: Record<string, unknown>[] = [summary];
    const seen: Message[] = [];
    const fetcher: Fetch = async (_url, init) => {
      seen.push(JSON.parse(String(init?.body)));
      const headers = { "request-id": `req_${seen.length}` };
      const result = seen.length === 1 ? content : [{ type: "text", text: "Blue." }];
      return streaming
        ? new Response(streamed(`msg_${seen.length}`, result, seen.length === 1 ? "compaction" : "end_turn"), { headers: { ...headers, "content-type": "text/event-stream" } })
        : Response.json({ id: `msg_${seen.length}`, role: "assistant", content: result, stop_reason: seen.length === 1 ? "compaction" : "end_turn" }, { headers });
    };
    const make = () => new Transport(fetcher, "https://mock.invalid", undefined, new HistoryStore(directory));
    const session = crypto.randomUUID();
    const context_management = { edits: [{ type: "compact_20260112", pause_after_compaction: true }] };
    const params = mode === "threshold" ? { context_management } : { compaction: { type: "summarize" } };
    const input = { ...first, ...params, stream: streaming };
    const send = async (transport: Transport, body: Message) => (await transport.message(account, body, session, crypto.randomUUID(),
      [mode === "threshold" ? "compact-2026-01-12" : "compact-2026-09-04"], new AbortController().signal)).text();
    await send(make(), input);
    const reply = { role: "assistant" as const, content };
    const followup = { role: "user" as const, content: "Which color?" };
    const continuation = { ...first, stream: streaming, ...(mode === "threshold" && { context_management }) };
    await send(make(), { ...continuation, messages: [reply, followup] });
    // Only threshold compaction permits the summarized prefix to remain.
    if (mode === "threshold") await send(make(), { ...continuation, messages: [...first.messages, reply, followup] });
    for (const sent of seen.slice(1)) {
      expect(sent.diagnostics).toEqual({ previous_message_id: "msg_1" });
      expect(JSON.stringify(sent.system)).toContain("cc_prev_req=req_1;");
      const message = sent.messages.find(message => Array.isArray(message.content) && message.content[0]?.type === "compaction");
      expect(Array.isArray(message?.content) ? message.content[0] : undefined).toEqual(summary);
      if (mode === "threshold") expect(sent.context_management).toEqual(context_management);
    }
    expect(seen[0]?.[mode === "threshold" ? "context_management" : "compaction"]).toEqual(mode === "threshold" ? context_management : { type: "summarize" });
  }
});

test("repeated text on separate branches links to its own response, never to the latest session response", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude-history-branches-")); directories.push(directory);
  const seen: Message[] = [];
  const transport = new Transport(async (_url, init) => {
    seen.push(JSON.parse(String(init?.body)));
    return Response.json({ id: `msg_${seen.length}`, content: [{ type: "text", text: "OK" }] }, { headers: { "request-id": `req_${seen.length}` } });
  }, "https://mock.invalid", undefined, new HistoryStore(directory));
  const session = crypto.randomUUID();
  const send = (body: Message) => transport.message(account, body, session, crypto.randomUUID(), [], new AbortController().signal);
  const branch: Message = { ...first, messages: [{ role: "user", content: "Remember red." }] };
  await send(first); await send(branch);
  for (const input of [first, branch]) await send({ ...input, messages: [...input.messages, { role: "assistant", content: "OK" }, { role: "user", content: "Next" }] });
  expect(seen[2]?.diagnostics).toEqual({ previous_message_id: "msg_1" });
  expect(seen[3]?.diagnostics).toEqual({ previous_message_id: "msg_2" });
  await send({ ...first, messages: [...first.messages, { role: "assistant", content: "edited" }, { role: "user", content: "Next" }] });
  expect(seen[4]?.diagnostics).toEqual({ previous_message_id: null });
  expect(JSON.stringify(seen[4]?.system)).not.toContain("cc_prev_req");
});
