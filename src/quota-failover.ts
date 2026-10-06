import { observeEvents } from "./responses-events.ts";

type Options = {
  retry: boolean;
  choose(excluded: ReadonlySet<string>): Promise<string>;
  execute(id: string): Promise<Response>;
  quota(event: unknown): boolean;
  limit(id: string, headers: Headers, event: unknown): void;
};

// Inspect only the bootstrap, before returning any response bytes. Once the
// first data event is accepted, errors are observed but never replayed.
async function bootstrap(response: Response, quota: Options["quota"]) {
  let event: unknown;
  if (!response.body || !response.headers.get("content-type")?.startsWith("text/event-stream"))
    return { response, rejected: false, event };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  const decoder = new TextDecoder();
  let pending = "", bytes = 0, rejected = false;
  outer: for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    chunks.push(chunk.value);
    bytes += chunk.value.byteLength;
    pending += decoder.decode(chunk.value, { stream: true });
    const frames = pending.split(/\r?\n\r?\n/);
    pending = frames.pop() ?? "";
    for (const frame of frames) {
      const lines = frame.split(/\r?\n/).filter(line => line.startsWith("data:"));
      if (!lines.length) continue;
      const data = lines.map(line => line.slice(5).trimStart()).join("\n");
      try { event = JSON.parse(data); rejected = quota(event); } catch { /* Unknown events commit the stream unchanged. */ }
      break outer;
    }
    // Forward heartbeat-only chunks immediately, so an idle stream remains
    // observable/cancellable. Emitting them also ends transparent retry eligibility.
    if (frames.length || bytes >= 256_000) break;
  }
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const buffered = chunks.shift();
      if (buffered) { controller.enqueue(buffered); return; }
      try {
        const next = await reader.read();
        if (next.done) controller.close(); else controller.enqueue(next.value);
      } catch (cause) { controller.error(cause); }
    },
    cancel(reason) { return reader.cancel(reason); },
  }, { highWaterMark: 0 });
  return { response: new Response(body, { status: response.status, headers: response.headers }), rejected, event };
}

export async function quotaFailover(options: Options) {
  const excluded = new Set<string>();
  let id = await options.choose(excluded);
  for (;;) {
    excluded.add(id);
    let response = await options.execute(id);
    let rejected = false, event: unknown;
    if (response.status === 429) {
      try { event = await response.clone().json(); rejected = options.quota(event); } catch { /* Ambiguous 429 passes through. */ }
    } else if (response.ok) {
      ({ response, rejected, event } = await bootstrap(response, options.quota));
    }
    const observe = (event: unknown) => { if (options.quota(event)) options.limit(id, response.headers, event); };
    if (rejected) {
      options.limit(id, response.headers, event);
      if (options.retry && response.headers.get("x-should-retry") !== "false") {
        let next: string;
        try { next = await options.choose(excluded); } catch { return response; }
        await response.body?.cancel();
        id = next;
        continue;
      }
    }
    const body = response.body && response.headers.get("content-type")?.startsWith("text/event-stream")
      ? observeEvents(response.body, observe) : response.body;
    return new Response(body, { status: response.status, headers: response.headers });
  }
}
