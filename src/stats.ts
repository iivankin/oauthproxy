export type Provider = "Claude" | "Codex";
type Outcome = "completed" | "errors" | "cancelled";
export type Counter = {
  provider: Provider; account: string; transport: "HTTP" | "WS";
  total: number; active: number; completed: number; errors: number; cancelled: number;
};

export class Stats {
  readonly since = new Date();
  private readonly counters = new Map<string, Counter>();

  snapshot() { return [...this.counters.values()].map(row => ({ ...row })); }

  start(provider: Provider, account: string, transport: Counter["transport"]) {
    const key = JSON.stringify([provider, account, transport]);
    let row = this.counters.get(key);
    if (!row) {
      row = { provider, account, transport, total: 0, active: 0, completed: 0, errors: 0, cancelled: 0 };
      this.counters.set(key, row);
    }
    row.total++;
    row.active++;
    let finished = false;
    return (outcome: Outcome) => {
      if (finished) return;
      finished = true;
      row.active--;
      row[outcome]++;
    };
  }

  async http(provider: Provider, account: string, signal: AbortSignal, call: () => Promise<Response>) {
    const done = this.start(provider, account, "HTTP");
    const abort = () => done("cancelled");
    signal.addEventListener("abort", abort, { once: true });
    const finish = (outcome: Outcome) => {
      signal.removeEventListener("abort", abort);
      done(outcome);
    };
    try {
      signal.throwIfAborted();
      const response = await call();
      if (!response.ok || !response.body) {
        finish(response.ok ? "completed" : "errors");
        return response;
      }
      const reader = response.body.getReader();
      // Observe transport completion without parsing SSE, buffering ahead, or changing bytes.
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const chunk = await reader.read();
            if (chunk.done) { finish("completed"); controller.close(); }
            else controller.enqueue(chunk.value);
          } catch (error) { finish(signal.aborted ? "cancelled" : "errors"); controller.error(error); }
        },
        cancel(reason) { finish("cancelled"); return reader.cancel(reason); },
      }, { highWaterMark: 0 });
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) { finish(signal.aborted ? "cancelled" : "errors"); throw error; }
  }
}
