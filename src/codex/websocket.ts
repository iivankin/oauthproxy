import WebSocket from "ws";
import { incomingHeaders } from "./headers.ts";
import { UpstreamError } from "./transport.ts";
import { NativeRelay } from "./relay.ts";

export const MAX_PAYLOAD = 32 * 1024 * 1024;

export function connectUpstream(url: string, headers: Record<string, string>, signal: AbortSignal) {
  return new Promise<{ socket: WebSocket; headers: Headers; relay: NativeRelay }>((resolve, reject) => {
    const socket = new WebSocket(url, { headers, handshakeTimeout: 20_000, followRedirects: false,
      perMessageDeflate: true, maxPayload: MAX_PAYLOAD });
    const relay = new NativeRelay(socket);
    let responseHeaders = new Headers();
    let settled = false;
    const deadline = setTimeout(() => fail(new Error("Upstream handshake timed out")), 20_000);
    const cleanup = () => { clearTimeout(deadline); signal.removeEventListener("abort", abort); };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
      socket.terminate();
    };
    const abort = () => fail(new Error("Downstream disconnected during handshake"));
    signal.addEventListener("abort", abort, { once: true });
    socket.on("error", () => fail(new Error("Upstream WebSocket transport failed")));
    socket.once("upgrade", response => { responseHeaders = incomingHeaders(response.headers); });
    socket.once("unexpected-response", (_request, response) => {
      const chunks: Buffer[] = [];
      let length = 0;
      response.on("data", (chunk: Buffer) => {
        length += chunk.length;
        if (length > MAX_PAYLOAD) { response.destroy(); fail(new Error("Upstream error body exceeds 32 MiB")); }
        else chunks.push(chunk);
      });
      response.once("error", () => fail(new Error("Cannot read upstream handshake error")));
      response.once("end", () => fail(new UpstreamError(response.statusCode ?? 502, Buffer.concat(chunks), incomingHeaders(response.headers))));
    });
    socket.once("open", () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ socket, headers: responseHeaders, relay });
    });
    if (signal.aborted) abort();
  });
}
