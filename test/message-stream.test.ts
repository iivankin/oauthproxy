import { expect, test } from "bun:test";
import type { BetaMessage } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { relayMessage } from "../src/message-stream.ts";

export const sse = (event: string, value: unknown) => `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`;
export const start = (id = "msg_first") => sse("message_start", { type: "message_start", message: {
  id, type: "message", role: "assistant", content: [], model: "claude-opus-4-6",
  stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 },
} });
export const end = (reason = "end_turn") => sse("message_delta", { type: "message_delta", delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: 5 } })
  + sse("message_stop", { type: "message_stop" });
export const block = (index: number, content: unknown) => sse("content_block_start", { type: "content_block_start", index, content_block: content });
export const delta = (index: number, value: unknown) => sse("content_block_delta", { type: "content_block_delta", index, delta: value });
export const stop = (index: number) => sse("content_block_stop", { type: "content_block_stop", index });

test("SDK assembles split SSE, tools, thinking and compaction; ping/unknown events survive and commit precedes message_stop", async () => {
  const wire = sse("ping", { type: "ping" }) + start()
    + block(0, { type: "compaction", content: "" })
    + delta(0, { type: "compaction_delta", content: "sum" })
    + delta(0, { type: "compaction_delta", content: "mary", encrypted_content: "opaque" }) + stop(0)
    + block(1, { type: "thinking", thinking: "", signature: "" })
    + delta(1, { type: "thinking_delta", thinking: "reason" }) + delta(1, { type: "signature_delta", signature: "signature" }) + stop(1)
    + block(2, { type: "tool_use", id: "tool_first", name: "echo", input: {} })
    + delta(2, { type: "input_json_delta", partial_json: '{"value":' })
    + delta(2, { type: "input_json_delta", partial_json: '"✓"}' }) + stop(2)
    + sse("future_event", { type: "future_event", keep: true }) + end("tool_use");
  const bytes = new TextEncoder().encode(wire.replaceAll("\n", "\r\n"));
  let offset = 0, committed = false, saved: BetaMessage | undefined;
  const source = new Response(new ReadableStream<Uint8Array>({ pull(controller) {
    if (offset >= bytes.length) return controller.close();
    controller.enqueue(bytes.slice(offset, offset += 7));
  } }), { headers: { "content-type": "text/event-stream" } });
  const response = relayMessage(source, async message => {
    await Bun.sleep(5);
    saved = message; committed = true;
  }, new AbortController());
  let output = "";
  for await (const chunk of response.body!) {
    const text = new TextDecoder().decode(chunk);
    if (text.includes("event: message_stop")) expect(committed).toBe(true);
    output += text;
  }
  expect(output).toBe(wire);
  expect(saved?.id).toBe("msg_first");
  expect(JSON.parse(JSON.stringify(saved?.content))).toEqual([
    { type: "compaction", content: "summary", encrypted_content: "opaque" },
    { type: "thinking", thinking: "reason", signature: "signature" },
    { type: "tool_use", id: "tool_first", name: "echo", input: { value: "✓" } },
  ]);
});

test("signed on-demand compaction is assembled intact without deltas", async () => {
  const content = { type: "compaction" as const, content: "summary", signature: "signed" };
  let saved: BetaMessage | undefined;
  const response = relayMessage(new Response(start() + block(0, content) + stop(0) + end("compaction")), async value => { saved = value; }, new AbortController());
  await response.text();
  expect(JSON.parse(JSON.stringify(saved?.content))).toEqual([content]);
  expect(saved?.stop_reason).toBe("compaction");
});

test("explicit SSE error is forwarded and closes cleanly without persisting partial messages", async () => {
  for (const prefix of ["", start() + block(0, { type: "text", text: "partial" })]) {
    const wire = prefix + sse("error", { type: "error", error: { type: "overloaded_error", message: "retry later" } });
    let calls = 0;
    const upstream = new AbortController();
    const response = relayMessage(new Response(wire), async () => { calls++; }, upstream);
    expect(await response.text()).toBe(wire);
    expect(calls).toBe(0);
    expect(upstream.signal.aborted).toBe(true);
  }
});

test("incomplete SSE is still a transport error and cancellation aborts upstream", async () => {
  let saved = 0;
  const incomplete = new AbortController();
  const broken = relayMessage(new Response(start() + block(0, { type: "text", text: "partial" })), async () => { saved++; }, incomplete);
  await expect(broken.text()).rejects.toThrow("without message_stop");
  expect(saved).toBe(0);
  expect(incomplete.signal.aborted).toBe(true);
  let calls = 0;
  const upstream = new AbortController();
  const response = relayMessage(new Response(start() + block(0, { type: "text", text: "OK" }) + stop(0) + end()), async () => { calls++; }, upstream);
  const reader = response.body!.getReader();
  await reader.read();
  await reader.cancel();
  await Bun.sleep(5);
  expect(calls).toBe(0);
  expect(upstream.signal.aborted).toBe(true);
});

test("streaming refusal preserves the full wire including stop_details", async () => {
  const wire = start() + block(0, { type: "text", text: "refusal" }) + stop(0)
    + sse("message_delta", { type: "message_delta", delta: { stop_reason: "refusal", stop_sequence: null,
      stop_details: { category: "test", explanation: null } }, usage: { output_tokens: 1 } })
    + sse("message_stop", { type: "message_stop" });
  let saved: BetaMessage | undefined;
  const response = relayMessage(new Response(wire), async message => { saved = message; }, new AbortController());
  expect(await response.text()).toBe(wire);
  expect(saved?.stop_reason).toBe("refusal");
});

test("slow client applies backpressure instead of letting SDK consume the whole response", async () => {
  const frames = [start(), block(0, { type: "text", text: "" }),
    ...Array.from({ length: 100 }, () => delta(0, { type: "text_delta", text: "x" })), stop(0), end()];
  let pulled = 0, saved = false;
  const upstream = new AbortController();
  const response = relayMessage(new Response(new ReadableStream<Uint8Array>({ pull(controller) {
    const frame = frames[pulled++];
    if (frame === undefined) return controller.close();
    controller.enqueue(new TextEncoder().encode(frame));
  } })), async () => { saved = true; }, upstream);
  const reader = response.body!.getReader();
  await reader.read();
  await Bun.sleep(10);
  expect(pulled).toBeLessThan(10);
  expect(saved).toBe(false);
  await reader.cancel();
});
