import { afterEach, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { fixture } from "./codex-fixture.ts";

const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
async function setup() { const f = await fixture(); fixtures.push(f); return f; }
afterEach(async () => { for (const f of fixtures.splice(0)) await f.close(); });
const headers = { authorization: "Bearer local-key", "content-type": "application/json", "session-id": "sse-session" };
const body = JSON.stringify({ model: "test-model", input: [{ role: "user", content: "Hi" }], stream: true, store: false });
const encode = (text: string) => new TextEncoder().encode(text);

test("native HTTP SSE delivers the first event before EOF, retaining raw request and response bytes", async () => {
  const f = await setup();
  const output = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
  const first = ': keepalive\r\nevent: response.created\r\ndata: {"type":"response.created","response":{"id":"resp_1"}}\r\n\r\n';
  const last = 'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","output":[],"future":123}}\n\n';
  f.options.onResponses = () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(encode(first)); output.resolve(controller); },
  }), { headers: { "content-type": "text/event-stream", "x-request-id": "req_native", "x-codex-turn-state": "server-state" } });
  const raw = '{ "model":"test-model", "stream":true, "store":false, "instructions":"CUSTOM ONLY", "tools":[], "input":[{"type":"reasoning","encrypted_content":"opaque+/=="},{"role":"user","content":"hi"}], "context_management":[{"type":"compaction","compact_threshold":1000}], "future":42 }';
  const response = await fetch(`${f.url}v1/responses`, { method: "POST", headers: { ...headers,
    "chatgpt-account-id": "do-not-forward", "x-codex-turn-state": "stale", cookie: "private", "openai-beta": "bad" }, body: raw });
  expect(response.status).toBe(200);
  expect(response.headers.get("session-id")).toBe("sse-session");
  expect(response.headers.get("x-request-id")).toBe("req_native");
  expect(response.headers.get("x-codex-turn-state")).toBe("server-state");
  expect(response.headers.get("x-accel-buffering")).toBe("no");
  const reader = response.body!.getReader();
  const chunk = await reader.read();
  expect(new TextDecoder().decode(chunk.value)).toBe(first);
  const controller = await output.promise;
  controller.enqueue(encode(last));
  controller.close();
  let tail = "";
  for (;;) { const chunk = await reader.read(); if (chunk.done) break; tail += new TextDecoder().decode(chunk.value); }
  expect(tail).toBe(last);
  const requests = f.calls.filter(call => call.path === "/responses");
  expect(requests).toHaveLength(1);
  expect(requests[0]!.body).toBe(raw);
  expect(requests[0]!.headers.accept).toBe("text/event-stream");
  expect(requests[0]!.headers["session-id"]).toBe("sse-session");
  expect(requests[0]!.headers["thread-id"]).toBe("sse-session");
  expect(requests[0]!.headers.authorization).toMatch(/^Bearer [ab]-access$/);
  expect(requests[0]!.headers["chatgpt-account-id"]).toMatch(/^[ab]$/);
  for (const name of ["cookie", "x-codex-turn-state", "openai-beta", "x-api-key"]) expect(requests[0]!.headers[name]).toBeUndefined();
  expect(f.handshakes).toHaveLength(0);
});

test("HTTP errors retain status, body and retry headers without quota rotation or replay", async () => {
  const f = await setup();
  for (const status of [400, 429, 503]) {
    const raw = `<html>failure ${status}</html>`;
    f.options.onResponses = () => new Response(gzipSync(raw), { status, headers: {
      "content-type": "text/html", "content-encoding": "gzip", "retry-after": "60", "x-request-id": `req_${status}`, "set-cookie": "secret=1",
    } });
    const response = await fetch(`${f.url}v1/responses`, { method: "POST", headers, body });
    expect(response.status).toBe(status);
    expect(await response.text()).toBe(raw);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(response.headers.get("x-request-id")).toBe(`req_${status}`);
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
  }
  expect(f.calls.filter(call => call.path === "/responses")).toHaveLength(3);
});

test("SSE errors, refusals and unknown events pass through without parsing or retries", async () => {
  const f = await setup();
  const raw = 'event: response.refusal.delta\ndata: {"type":"response.refusal.delta","delta":"No"}\n\nevent: future.event\ndata: {"future":1}\n\nevent: error\ndata: {"type":"error","code":"usage_limit_reached","headers":{"retry-after":"999"}}\n\n';
  f.options.onResponses = () => new Response(raw, { headers: { "content-type": "text/event-stream" } });
  const response = await fetch(`${f.url}v1/responses`, { method: "POST", headers, body });
  expect(response.status).toBe(200);
  expect(await response.text()).toBe(raw);
  expect(f.calls.filter(call => call.path === "/responses")).toHaveLength(1);
});

test("401 refresh is bounded to one retry on the same account, with unchanged body", async () => {
  for (const succeeds of [true, false]) {
    const f = await setup();
    f.usage.set("Bearer b-access", { rate_limit: { allowed: false, limit_reached: true } });
    f.options.onResponses = request => {
      if (succeeds && request.headers.get("authorization") === "Bearer a-refreshed")
        return new Response("event: response.completed\ndata: {}\n\n", { headers: { "content-type": "text/event-stream" } });
      return new Response("auth rejected", { status: 401, headers: { "x-request-id": "auth_failure" } });
    };
    const response = await fetch(`${f.url}v1/responses`, { method: "POST", headers, body });
    expect(response.status).toBe(succeeds ? 200 : 401);
    if (!succeeds) { expect(await response.text()).toBe("auth rejected"); expect(response.headers.get("x-request-id")).toBe("auth_failure"); }
    else await response.body?.cancel();
    const requests = f.calls.filter(call => call.path === "/responses");
    expect(requests.map(call => call.headers.authorization)).toEqual(["Bearer a-access", "Bearer a-refreshed"]);
    expect(requests.map(call => call.headers["chatgpt-account-id"])).toEqual(["a", "a"]);
    expect(requests.map(call => call.body)).toEqual([body, body]);
    expect(f.calls.filter(call => call.path === "/oauth/token")).toHaveLength(1);
  }
});

test("client cancellation aborts the upstream stream without another request", async () => {
  const f = await setup();
  const cancelled = Promise.withResolvers<void>();
  f.options.onResponses = request => {
    request.signal.addEventListener("abort", () => cancelled.resolve(), { once: true });
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(encode(": ready\n\n")); } }),
      { headers: { "content-type": "text/event-stream" } });
  };
  const response = await fetch(`${f.url}v1/responses`, { method: "POST", headers, body });
  const reader = response.body!.getReader();
  await reader.read();
  await reader.cancel();
  await cancelled.promise;
  expect(f.calls.filter(call => call.path === "/responses")).toHaveLength(1);
});

test("invalid SSE requests and local authentication fail before upstream generation", async () => {
  const f = await setup();
  const cases = [
    { headers: { ...headers, authorization: "Bearer wrong" }, body, status: 401 },
    { headers: { ...headers, origin: "https://bad.invalid" }, body, status: 403 },
    { headers: { ...headers, "content-type": "text/plain" }, body, status: 415 },
    { headers, body: "{", status: 400 },
    { headers, body: JSON.stringify({ model: "test-model", input: [], stream: false }), status: 400 },
  ];
  for (const c of cases) {
    const response = await fetch(`${f.url}v1/responses`, { method: "POST", headers: c.headers, body: c.body });
    expect(response.status).toBe(c.status);
    await response.body?.cancel();
  }
  expect(f.calls).toHaveLength(0);
});
