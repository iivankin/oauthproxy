import { Stream } from "@anthropic-ai/sdk/core/streaming";
import { BetaMessageStream } from "@anthropic-ai/sdk/lib/BetaMessageStream";
import type { BetaMessage } from "@anthropic-ai/sdk/resources/beta/messages/messages";

const messageEvents = new Set(["message_start", "message_delta", "message_stop",
  "content_block_start", "content_block_delta", "content_block_stop"]);
const encoder = new TextEncoder();

export function relayMessage(response: Response, accept: (message: BetaMessage) => Promise<void>, upstream: AbortController): Response {
  if (!response.ok || !response.body) return response;
  const output = new TransformStream<Uint8Array, Uint8Array>();
  const writer = output.writable.getWriter();
  let accumulator: BetaMessageStream;
  let complete = false;
  let upstreamError = false;

  async function* feedSDK() {
    try {
      for await (const event of Stream.rawEvents(response, upstream)) {
        if (messageEvents.has(event.event ?? "")) {
          // The public SDK accumulator consumes JSONL, not SSE. Feeding one
          // event per pull lets it assemble tools/thinking/compaction itself,
          // without a tee or an unbounded second queue. After yield resumes,
          // that event has been applied to currentMessage by the SDK.
          yield encoder.encode(JSON.stringify(JSON.parse(event.data)) + "\n");
          if (event.event === "message_stop" && accumulator.currentMessage) {
            await accept(accumulator.currentMessage);
            complete = true;
          }
        }
        // Preserve ping, error and unknown SSE events too; only line endings
        // are normalized by the SDK parser. Never expose its JSONL downstream.
        await writer.write(encoder.encode(event.raw.join("\n") + "\n\n"));
        if (event.event === "error") {
          upstreamError = true;
          return;
        }
      }
      if (!complete) throw new Error("Upstream stream ended without message_stop");
    } finally {
      if (!complete) upstream.abort();
    }
  }

  const events = feedSDK();
  accumulator = BetaMessageStream.fromReadableStream(new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await events.next();
      if (next.done) controller.close(); else controller.enqueue(next.value);
    },
    async cancel() { upstream.abort(); await events.return(); },
  }, { highWaterMark: 0 }));
  void writer.closed.catch(() => { upstream.abort(); accumulator.abort(); });
  // An explicit SSE error is already the protocol-level failure. The SDK may
  // reject an empty/partial snapshot, but don't add a second transport failure.
  void accumulator.done().then(() => writer.close(), error => upstreamError ? writer.close() : writer.abort(error)).catch(() => {});
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  return new Response(output.readable, { status: response.status, headers });
}
