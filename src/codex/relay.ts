import WebSocket from "ws";
import type { ServerWebSocket } from "bun";

const BUFFER_LIMIT = 32 * 1024 * 1024;
type Frame = string | Buffer;

// Bun's native ws compatibility layer has no pause/resume. Bound both send queues
// and close explicitly on overflow, rather than pretending to exert backpressure.
export class NativeRelay {
  private client?: ServerWebSocket<NativeRelay>;
  private pending: Frame[] = [];
  private pendingBytes = 0;
  private ended?: { code: number; reason: string };
  onClose = () => {};

  constructor(readonly upstream: WebSocket, readonly limit = BUFFER_LIMIT) {
    upstream.on("message", (data, binary) => {
      const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(new Uint8Array(data));
      this.receive(binary ? bytes : bytes.toString());
    });
    upstream.on("close", (code, reason) => {
      this.ended = { code, reason: reason.toString() };
      if (code === 1006) this.client?.terminate();
      else this.client?.close(code === 1005 ? undefined : code, reason.toString());
      this.pending = [];
      this.pendingBytes = 0;
      this.onClose();
    });
    upstream.on("error", () => this.client?.terminate());
  }

  attach(client: ServerWebSocket<NativeRelay>) {
    this.client = client;
    if (this.ended) { client.close(1011, "Upstream closed before local upgrade"); return; }
    const frames = this.pending;
    this.pending = [];
    this.pendingBytes = 0;
    for (const frame of frames) this.receive(frame);
  }

  private receive(frame: Frame) {
    if (this.ended) return;
    const size = Buffer.byteLength(frame);
    if (size > this.limit) { this.overflow(); return; }
    if (!this.client) {
      this.pendingBytes += size;
      if (this.pendingBytes > this.limit) { this.overflow(); return; }
      this.pending.push(frame);
      return;
    }
    if (this.client.getBufferedAmount() + size > this.limit) { this.overflow(); return; }
    const written = typeof frame === "string" ? this.client.sendText(frame) : this.client.sendBinary(frame);
    if (written === 0 && size > 0) this.overflow();
  }

  send(frame: Frame) {
    if (this.upstream.readyState !== WebSocket.OPEN) { this.client?.close(1011, "Upstream is not open"); return; }
    if (Buffer.byteLength(frame) + this.upstream.bufferedAmount > this.limit) { this.overflow(); return; }
    this.upstream.send(frame, { binary: typeof frame !== "string" }, error => {
      if (error) { this.upstream.terminate(); this.client?.terminate(); }
    });
  }

  close(code: number, reason: string) {
    if (this.upstream.readyState !== WebSocket.OPEN) { this.upstream.terminate(); return; }
    if (code === 1006 || code === 1015) this.upstream.terminate();
    else this.upstream.close(code === 1005 ? undefined : code, reason);
  }

  private overflow() {
    this.pending = [];
    this.pendingBytes = 0;
    this.ended = { code: 1013, reason: "Proxy buffer limit exceeded" };
    this.client?.close(1013, this.ended.reason);
    if (this.upstream.readyState === WebSocket.OPEN) this.upstream.close(1013, this.ended.reason);
    else this.upstream.terminate();
  }
}
