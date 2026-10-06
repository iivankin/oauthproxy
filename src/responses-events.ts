export function responseError(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null) return;
  const root = value as Record<string, unknown>;
  const response = typeof root.response === "object" && root.response !== null ? root.response as Record<string, unknown> : {};
  const error = root.error ?? response.error;
  return typeof error === "object" && error !== null ? error as Record<string, unknown> : undefined;
}

export function observeEvents(body: ReadableStream<Uint8Array>, observe: (event: unknown) => void) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let discard = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) { controller.close(); return; }
        pending += decoder.decode(chunk.value, { stream: true });
        const frames = pending.split(/\r?\n\r?\n/);
        pending = frames.pop() ?? "";
        for (const frame of frames) {
          if (discard) { discard = false; continue; }
          if (frame.length > 256_000) continue;
          const data = frame.split(/\r?\n/).filter(line => line.startsWith("data:"))
            .map(line => line.slice(5).trimStart()).join("\n");
          try { observe(JSON.parse(data)); } catch { /* Unknown data remains byte-for-byte intact. */ }
        }
        // Do not recognize a fragment of an oversized event as a new event.
        if (pending.length > 256_000) { pending = ""; discard = true; }
        controller.enqueue(chunk.value);
      } catch (cause) { controller.error(cause); }
    },
    cancel(reason) { return reader.cancel(reason); },
  }, { highWaterMark: 0 });
}
