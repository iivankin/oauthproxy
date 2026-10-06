import type { RelayClient, SocketRelay } from "./codex/relay.ts";
import { MAX_PAYLOAD, connectUpstream } from "./codex/websocket.ts";

type Frame = string | Buffer;
type Upstream = Awaited<ReturnType<typeof connectUpstream>>;
type Options = {
  choose(model: string | undefined, excluded: ReadonlySet<string>): Promise<string>;
  connect(account: string, signal: AbortSignal): Promise<Upstream>;
  error(cause: unknown): Response;
  quota(event: unknown): boolean;
};
type Pending = { frame: Frame; started: boolean; attempted: Set<string> };

function event(frame: Frame): Record<string, unknown> {
  try {
    const value: unknown = typeof frame === "string" ? JSON.parse(frame) : undefined;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch { /* Ordinary frames remain opaque; recovery requires a JSON create event. */ }
  return {};
}

// The upstream connection, not a logical conversation/model/stream_id, owns
// WS account affinity. Warmup happens before any response.create is received.
export class AccountSocket implements SocketRelay {
  private client?: RelayClient;
  private quotaEnded = false;
  private ended = false;
  private pendingBytes = 0;
  private queue: Promise<void> = Promise.resolve();
  private readonly abort = new AbortController();
  private readonly requests = new Map<string, Pending>();
  private requestBytes = 0;

  constructor(private account: string, private upstream: Upstream, private readonly options: Options) {}

  private bridge?: RelayClient;

  attach(client: RelayClient) {
    this.client = client;
    this.bridge = {
      sendText: frame => this.receive(frame),
      sendBinary: frame => { for (const request of this.requests.values()) request.started = true; return client.sendBinary(frame); },
      getBufferedAmount: () => client.getBufferedAmount(),
      terminate: () => client.terminate(),
      close: (code, reason) => client.close(code, reason),
    };
    this.upstream.relay.attach(this.bridge);
  }

  limited(account: string) {
    if (account !== this.account) return;
    this.quotaEnded = true;
    this.upstream.relay.preserveClientOnClose = true;
  }

  send(frame: Frame) {
    if (this.ended) return;
    const size = Buffer.byteLength(frame);
    this.pendingBytes += size;
    if (this.pendingBytes > MAX_PAYLOAD) { this.close(1013, "Proxy buffer limit exceeded"); return; }
    // Bound and serialize frames while a quota-triggered replacement connects.
    this.queue = this.queue.then(async () => {
      if (this.ended) return;
      if (this.quotaEnded) await this.replace(frame, new Set([this.account]));
      if (!this.ended) { this.remember(frame); this.upstream.relay.send(frame); }
    }).catch(async cause => {
      if (this.ended) return;
      const response = this.options.error(cause);
      const raw = await response.text();
      let error: unknown;
      try { error = JSON.parse(raw).error; } catch { /* Non-JSON errors retain their raw message. */ }
      const streamId = event(frame).stream_id;
      this.emit({ type: "error", status: response.status, error: error ?? { type: "upstream_error", message: raw },
        headers: Object.fromEntries(response.headers), ...(streamId !== undefined && { stream_id: streamId }) });
      // No replay and no credential rotation for ordinary account/transport errors.
      this.close(1011, "Upstream account or connection failed");
    }).finally(() => { this.pendingBytes -= size; });
  }

  private remember(frame: Frame) {
    const request = event(frame);
    if (request.type !== "response.create") return;
    const key = JSON.stringify(request.stream_id ?? null);
    // Concurrent untagged creates cannot be safely correlated to a rejection.
    const previous = this.requests.get(key);
    this.forget(key);
    this.requests.set(key, { frame, started: Boolean(previous), attempted: new Set([this.account]) });
    this.requestBytes += Buffer.byteLength(frame);
    if (this.requestBytes > MAX_PAYLOAD) this.close(1013, "Proxy buffer limit exceeded");
  }

  private forget(key: string) {
    const request = this.requests.get(key);
    if (request) this.requestBytes -= Buffer.byteLength(request.frame);
    this.requests.delete(key);
  }

  private receive(frame: string): number {
    const payload = event(frame);
    const key = payload.stream_id !== undefined ? JSON.stringify(payload.stream_id)
      : this.requests.size === 1 ? this.requests.keys().next().value : undefined;
    const request = key === undefined ? undefined : this.requests.get(key);
    if (request && this.options.quota(payload)) {
      const original = event(request.frame);
      if (!request.started && this.requests.size === 1 && Array.isArray(original.input) && !original.previous_response_id) {
        // Suppress only a confirmed rejection of a self-contained, unstarted
        // request. Never replay concurrent or partially delivered generations.
        request.started = true;
        this.queue = this.queue.then(async () => {
          if (this.ended) return;
          try {
            await this.replace(request.frame, request.attempted);
            request.attempted.add(this.account);
            request.started = false;
            this.upstream.relay.send(request.frame);
          } catch {
            this.forget(key!);
            this.deliver(frame); // No alternative: retain the original upstream error.
          }
        });
        return Buffer.byteLength(frame);
      }
    }
    if (request) request.started = true;
    else for (const pending of this.requests.values()) pending.started = true;
    if (key !== undefined && ["response.completed", "response.done", "response.failed", "error"].includes(String(payload.type))) this.forget(key);
    return this.deliver(frame);
  }

  private deliver(frame: string) {
    if (this.client && this.client.getBufferedAmount() + Buffer.byteLength(frame) > MAX_PAYLOAD) {
      this.close(1013, "Proxy buffer limit exceeded");
      return 0;
    }
    return this.client?.sendText(frame) ?? 0;
  }

  private async replace(frame: Frame, excluded: ReadonlySet<string>) {
    const request = event(frame);
    const account = await this.options.choose(typeof request.model === "string" ? request.model : undefined, excluded);
    const upstream = await this.options.connect(account, this.abort.signal);
    if (this.ended) { upstream.socket.terminate(); return; }
    // A planned replacement must not propagate the old upstream's close to
    // the still-live downstream. IDs are passed unchanged, not reconstructed.
    this.upstream.relay.detach();
    this.upstream.socket.close(1000, "Quota exhausted");
    this.account = account;
    this.upstream = upstream;
    this.quotaEnded = false;
    upstream.relay.attach(this.bridge!);
  }

  private emit(event: unknown) {
    const frame = JSON.stringify(event);
    if (this.client && this.client.getBufferedAmount() + Buffer.byteLength(frame) <= MAX_PAYLOAD) this.client.sendText(frame);
  }

  close(code: number, reason: string) {
    if (this.ended) return;
    this.ended = true;
    this.abort.abort();
    this.upstream.relay.close(code, reason);
    this.client?.close(code === 1005 ? undefined : code === 1006 || code === 1015 ? 1011 : code, reason);
  }
}
