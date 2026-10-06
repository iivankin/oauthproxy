import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { sessionId } from "../src/session-id.ts";
import { SessionBindings } from "../src/session-bindings.ts";
import { Accounts as CodexAccounts } from "../src/codex/accounts.ts";
import { fixture, openSocket } from "./codex-fixture.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });

test("explicit session headers follow priority; Claude metadata outranks Codex and generic headers", () => {
  const names = ["x-claude-code-session-id", "session-id", "session_id", "thread-id", "thread_id",
    "x-http-session-id", "x-session-id", "x-session-affinity", "x-slot-session-id", "x-task-id",
    "x-conversation-id", "x-thread-id", "x-client-request-id"];
  const headers = new Headers(names.map((name, index) => [name, `id-${index}`]));
  for (const [index, name] of names.entries()) {
    expect(sessionId(headers, { prompt_cache_key: "body-id" })).toBe(`id-${index}`);
    headers.delete(name);
  }
  expect(sessionId(headers, { prompt_cache_key: "body-id" })).toBe("body-id");
  const claude = { metadata: { user_id: JSON.stringify({ device_id: "device", session_id: "claude-session" }) } };
  expect(sessionId(new Headers({ "session-id": "codex-session" }), claude)).toBe("claude-session");
  expect(sessionId(new Headers(), { metadata: { user_id: "user_device_account_id_session_0123-abcd" } })).toBe("0123-abcd");
  expect(sessionId(new Headers({ "x-codex-turn-metadata": '{"thread_id":"thread"}' }))).toBe("thread");
});

test("body ID priority supports nested requests and rejects missing, malformed or overlong identities", () => {
  const headers = new Headers();
  expect(sessionId(headers, { sessionId: "session", prompt_cache_key: "cache", conversation: "conversation" })).toBe("session");
  expect(sessionId(headers, { promptCacheKey: "cache", conversation: { id: "conversation" } })).toBe("cache");
  expect(sessionId(headers, { conversation: { id: "conversation" }, metadata: { user_id: "user" } })).toBe("conversation");
  expect(sessionId(headers, { request: { extra_body: { session_id: "nested" } } })).toBe("nested");
  expect(sessionId(headers, { metadata: { user_id: "user" }, conversation_id: "legacy" })).toBe("user");
  expect(sessionId(headers, { metadata: { user_id: '{"session_id":"parsed"}' } })).toBe("parsed");
  for (const value of [undefined, "", "   ", "a\n", "a".repeat(257), 123])
    expect(sessionId(headers, { session_id: value })).toBeUndefined();
  expect(sessionId(headers, { input: [{ role: "user", content: "same initial prompt" }] })).toBeUndefined();
});

test("disk bindings serialize concurrent selection, isolate provider/model and survive restart without expiry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "session-binding-test-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const bindings = new SessionBindings(directory, "codex");
  let calls = 0;
  const select = (preferred?: string) => Promise.resolve(preferred ?? `account-${++calls}`);
  expect(await Promise.all(Array.from({ length: 12 }, () => bindings.select("session", "model-a", select))))
    .toEqual(Array(12).fill("account-1"));
  const restarted = new SessionBindings(directory, "codex");
  expect(await restarted.select("session", "model-a", select)).toBe("account-1");
  expect(await restarted.select("session", "model-b", select)).toBe("account-2");
  expect(await new SessionBindings(directory, "chatgpt").select("session", "model-a", select)).toBe("account-3");
  for (const name of await readdir(directory)) expect((await stat(join(directory, name))).mode & 0o777).toBe(0o600);
  await restarted.select("session", "model-a", () => Promise.resolve("replacement"));
  expect(await new SessionBindings(directory, "codex").select("session", "model-a", select)).toBe("replacement");
  await expect(restarted.select("session", "model-a", () => Promise.reject(new Error("quota check unavailable"))))
    .rejects.toThrow("quota check unavailable");
  expect(await restarted.select("session", "model-a", select)).toBe("replacement");
});

test("failed disk writes warn but keep the binding in memory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "session-binding-test-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const blocked = join(directory, "not-a-directory");
  await writeFile(blocked, "occupied");
  const bindings = new SessionBindings(blocked, "claude");
  // Start with a directory, then make only publication fail after a cold lookup.
  const path = join(directory, "bindings");
  const writable = new SessionBindings(path, "claude");
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const pick = async () => { await writeFile(path, "occupied"); return "account"; };
    expect(await writable.select("session", "model", pick)).toBe("account");
    expect(await writable.select("session", "model", preferred => Promise.resolve(preferred!))).toBe("account");
    expect(warn).toHaveBeenCalledTimes(1);
    await expect(bindings.select("session", "model", async () => "other")).rejects.toThrow();
  } finally { warn.mockRestore(); }
});

test("Codex SSE sticks across requests/restarts, rebinds on verified quota exhaustion, and rejects missing IDs", async () => {
  const f = await fixture();
  cleanups.push(() => f.close());
  const headers = { authorization: "Bearer local-key", "content-type": "application/json", "x-session-affinity": "chat-1" };
  const body = JSON.stringify({ model: "test-model", input: [], stream: true });
  const send = () => fetch(`${f.url}v1/responses`, { method: "POST", headers, body });
  for (let i = 0; i < 4; i++) expect(await (await send()).text()).toContain("response.completed");
  const calls = f.calls.filter(call => call.path === "/responses");
  const bearer = calls[0]!.headers.authorization;
  expect(new Set(calls.map(call => call.headers.authorization)).size).toBe(1);
  const accountId = (await f.accounts.store.read()).accounts.find(a => `Bearer ${a.accessToken}` === bearer)!.id;
  const restarted = new CodexAccounts(f.accounts.store, f.transport);
  expect(await restarted.choose("test-model", "chat-1")).toBe(accountId);
  f.usage.set(bearer!, { rate_limit: null });
  f.accounts.invalidateUsage(accountId);
  const beforeFailure = f.calls.filter(call => call.path === "/responses").length;
  expect((await send()).status).toBe(503);
  expect(f.calls.filter(call => call.path === "/responses")).toHaveLength(beforeFailure);
  f.usage.set(bearer!, { rate_limit: { allowed: false, limit_reached: true } });
  f.accounts.invalidateUsage(accountId);
  expect(await (await send()).text()).toContain("response.completed");
  expect(f.calls.filter(call => call.path === "/responses").at(-1)!.headers.authorization).not.toBe(bearer);
  const count = f.calls.length;
  const missing = await fetch(`${f.url}v1/responses`, { method: "POST",
    headers: { authorization: "Bearer local-key", "content-type": "application/json" }, body });
  expect(missing.status).toBe(400);
  expect(f.calls).toHaveLength(count);
});

test("WS opens upstream during warmup and ignores logical session/model/stream IDs for account routing", async () => {
  const f = await fixture();
  cleanups.push(() => f.close());
  f.options.models.push("test-model-2");
  f.usage.set("Bearer b-access", { rate_limit: { allowed: false, limit_reached: true } });
  const { socket, headers } = await openSocket(f.wsUrl, { "session-id": "" });
  expect(f.handshakes).toHaveLength(1);
  expect(f.frames).toHaveLength(0);
  expect(headers["session-id"]).toBeTruthy();
  expect(f.handshakes[0]!.authorization).toBe("Bearer a-access");
  f.usage.set("Bearer b-access", { rate_limit: { allowed: true, limit_reached: false } });
  f.accounts.invalidateUsage(f.b.id);
  await f.accounts.bindings.select("logical-b", "test-model-2", async () => f.b.id);
  const frames = [
    { type: "response.create", model: "test-model", session_id: "logical-a", stream_id: "stream-a", input: [] },
    { type: "response.create", model: "test-model-2", prompt_cache_key: "logical-b", stream_id: "stream-b", input: [] },
    { type: "response.create", model: "test-model", input: [] },
  ];
  for (const frame of frames) {
    const reply = once(socket, "message");
    const raw = JSON.stringify(frame);
    socket.send(raw);
    expect((await reply)[0].toString()).toBe(raw);
  }
  expect(f.handshakes).toHaveLength(1);
  expect(await f.accounts.choose("test-model-2", "logical-b")).toBe(f.b.id);
  socket.close();
});

test("WS forwards quota on a continuation and lets the new upstream reject an old previous_response_id", async () => {
  const f = await fixture();
  cleanups.push(() => f.close());
  f.usage.set("Bearer b-access", { rate_limit: { allowed: false, limit_reached: true } });
  const { socket } = await openSocket(f.wsUrl);
  f.usage.set("Bearer b-access", { rate_limit: { allowed: true, limit_reached: false } });
  f.accounts.invalidateUsage(f.b.id);
  const quota = JSON.stringify({ type: "error", status: 429,
    error: { type: "usage_limit_reached", resets_at: Math.floor(Date.now() / 1000) + 300 } });
  const notFound = JSON.stringify({ type: "error", status: 400,
    error: { code: "previous_response_not_found", param: "previous_response_id" } });
  f.options.onFrame = (client, frame) => {
    if (f.frames.length === 1) { client.send(quota); client.close(1000, "quota"); }
    else if (JSON.parse(frame).previous_response_id === "old") client.send(notFound);
    else client.send(frame);
  };
  const oldClosed = once(f.events, "upstream-close");
  const first = once(socket, "message");
  socket.send('{"type":"response.create","model":"test-model","previous_response_id":"old","input":[]}');
  expect((await first)[0].toString()).toBe(quota);
  await oldClosed;
  expect(socket.readyState).toBe(socket.OPEN);
  const delta = once(socket, "message");
  socket.send('{"type":"response.create","model":"test-model","previous_response_id":"old","input":[]}');
  expect((await delta)[0].toString()).toBe(notFound);
  expect(JSON.parse(f.frames[1]!).previous_response_id).toBe("old");
  expect(f.handshakes).toHaveLength(2);
  expect(f.frames).toHaveLength(2);
  const full = '{"type":"response.create","model":"test-model","stream_id":"new-stream","input":[{"role":"user","content":"Full context"}]}';
  const next = once(socket, "message");
  socket.send(full);
  expect((await next)[0].toString()).toBe(full);
  expect(f.handshakes.map(h => h.authorization)).toEqual(["Bearer a-access", "Bearer b-access"]);
  expect(f.frames).toHaveLength(3);
  const again = once(socket, "message");
  socket.send('{"type":"response.create","model":"test-model","previous_response_id":"new-account-id","input":[]}');
  expect(JSON.parse((await again)[0].toString()).previous_response_id).toBe("new-account-id");
  expect(f.handshakes).toHaveLength(2);
  socket.close();
});

test("WS transparently retries an unstarted full create and preserves stream_id", async () => {
  const f = await fixture();
  cleanups.push(() => f.close());
  f.usage.set("Bearer b-access", { rate_limit: { allowed: false, limit_reached: true } });
  const { socket } = await openSocket(f.wsUrl);
  f.usage.set("Bearer b-access", { rate_limit: { allowed: true, limit_reached: false } });
  f.accounts.invalidateUsage(f.b.id);
  const quota = JSON.stringify({ type: "error", status: 429, stream_id: "one", error: { type: "usage_limit_reached" } });
  const completed = JSON.stringify({ type: "response.completed", stream_id: "one", response: { id: "new" } });
  f.options.onFrame = (client) => client.send(f.frames.length === 1 ? quota : completed);
  const response = once(socket, "message");
  const full = '{"type":"response.create","model":"test-model","stream_id":"one","input":[{"role":"user","content":"Full"}]}';
  socket.send(full);
  expect((await response)[0].toString()).toBe(completed);
  expect(f.frames).toEqual([full, full]);
  expect(f.handshakes.map(h => h.authorization)).toEqual(["Bearer a-access", "Bearer b-access"]);
  socket.close();
});

test("WS never retries after output and returns original quota when no alternative remains", async () => {
  const f = await fixture();
  cleanups.push(() => f.close());
  const { socket } = await openSocket(f.wsUrl);
  const quota = JSON.stringify({ type: "error", status: 429, stream_id: "one", error: { type: "usage_limit_reached" } });
  const created = JSON.stringify({ type: "response.created", stream_id: "one" });
  const replies: string[] = [];
  socket.on("message", data => replies.push(data.toString()));
  f.options.onFrame = client => {
    if (f.frames.length === 1) client.send(created);
    client.send(quota);
  };
  const terminal = new Promise<void>(resolve => socket.on("message", data => { if (data.toString() === quota) resolve(); }));
  const full = '{"type":"response.create","model":"test-model","stream_id":"one","input":[]}';
  socket.send(full);
  await terminal;
  expect(replies).toEqual([created, quota]);
  expect(f.frames).toEqual([full]);
  expect(f.handshakes).toHaveLength(1);
  // Next create uses the remaining account, but there is nowhere else to retry.
  const next = once(socket, "message");
  socket.send(full);
  expect((await next)[0].toString()).toBe(quota);
  expect(f.frames).toEqual([full, full]);
  expect(f.handshakes).toHaveLength(2);
  socket.close();
});

test("Codex SSE retries only bootstrap quota, preserves late failures and previous_response_id", async () => {
  const f = await fixture();
  cleanups.push(() => f.close());
  const headers = { authorization: "Bearer local-key", "content-type": "application/json", "session-id": "retry" };
  const full = { model: "test-model", input: [{ role: "user", content: "Hello" }], stream: true };
  const send = (payload: unknown = full) => fetch(`${f.url}v1/responses`, { method: "POST", headers, body: JSON.stringify(payload) });
  const quota = 'event: error\r\ndata: {"type":"error","error":{"type":"usage_limit_reached"}}\r\n\r\n';
  const created = 'event: response.created\ndata: {"type":"response.created"}\n\n';
  const completed = 'event: response.completed\ndata: {"type":"response.completed"}\n\n';
  f.options.onResponses = () => new Response(f.calls.filter(call => call.path === "/responses").length === 1 ? quota : completed,
    { headers: { "content-type": "text/event-stream" } });
  expect(await (await send()).text()).toBe(completed);
  const calls = () => f.calls.filter(call => call.path === "/responses");
  expect(calls()).toHaveLength(2);
  expect(calls()[0]!.headers.authorization).not.toBe(calls()[1]!.headers.authorization);
  f.options.onResponses = () => new Response(created + quota, { headers: { "content-type": "text/event-stream" } });
  expect(await (await send()).text()).toBe(created + quota);
  expect(calls()).toHaveLength(3);
  // Even after receiving a quota event, a previous response is not rewritten.
  const f2 = await fixture();
  cleanups.push(() => f2.close());
  const notFound = '{"error":{"code":"previous_response_not_found","param":"previous_response_id"}}';
  f2.options.onResponses = () => new Response(notFound, { status: 400 });
  const response = await fetch(`${f2.url}v1/responses`, { method: "POST", headers,
    body: JSON.stringify({ ...full, previous_response_id: "old" }) });
  expect(response.status).toBe(400);
  expect(await response.text()).toBe(notFound);
  expect(JSON.parse(f2.calls.find(call => call.path === "/responses")!.body).previous_response_id).toBe("old");
});
