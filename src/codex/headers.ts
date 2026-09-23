import type { IncomingHttpHeaders } from "node:http";

export function incomingHeaders(source: IncomingHttpHeaders) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(source)) {
    if (Array.isArray(value)) for (const entry of value) headers.append(name, entry);
    else if (value !== undefined) headers.set(name, value);
  }
  return headers;
}

export function responseHeaders(source: Headers, upgrade = false) {
  const headers = new Headers(source);
  const hop = (source.get("connection") ?? "").split(",").map(name => name.trim().toLowerCase()).filter(Boolean);
  for (const name of ["connection", "upgrade", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer",
    "transfer-encoding", "content-length", "set-cookie", ...hop]) headers.delete(name);
  // Each leg negotiates its own WebSocket key, compression and subprotocol.
  for (const name of [...headers.keys()]) if (name.startsWith("sec-websocket-")) headers.delete(name);
  if (upgrade) headers.delete("content-encoding");
  return headers;
}
