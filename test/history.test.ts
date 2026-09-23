import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical, historyHash, previousHistoryHash, sha256, type History } from "../src/history.ts";
import { HistoryStore, type HistoryRecord } from "../src/history-store.ts";

const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "claude-history-test-"));
  directories.push(path);
  return path;
}
const history: History = [{ role: "user", content: "Question" }, { role: "assistant", content: "OK" }];
const record: HistoryRecord = { version: 1, sessionId: "session", accountId: "account", historyHash: historyHash(history), messageId: "msg_first", requestId: "req_first" };

test("history identity normalizes text/keys/cache markers, but not branches, order, tool inputs or signatures", () => {
  const blocked: History = [
    { role: "user", content: [{ text: "Question", type: "text", cache_control: { type: "ephemeral" } }] },
    { role: "assistant", content: [{ text: "OK", type: "text" }] },
  ];
  expect(historyHash(blocked)).toBe(historyHash(history));
  expect(previousHistoryHash([...history, { role: "user", content: "New" }])).toBe(historyHash(history));
  expect(historyHash([{ role: "user", content: "Different question" }, history[1]!])).not.toBe(historyHash(history));
  expect(historyHash([...history].reverse())).not.toBe(historyHash(history));
  const tool = (value: string): History => [{ role: "assistant", content: [{ type: "tool_use", id: "tool", name: "f", input: { cache_control: value } }] }];
  expect(historyHash(tool("a"))).not.toBe(historyHash(tool("b")));
  const thinking = (signature: string): History => [{ role: "assistant", content: [{ type: "thinking", thinking: "x", signature }] }];
  expect(historyHash(thinking("a"))).not.toBe(historyHash(thinking("b")));
});

test("compaction establishes a hash root without editing blocks; null summary does not discard history", () => {
  for (const summary of [
    { type: "compaction", content: "summary", encrypted_content: "encrypted" },
    { type: "compaction", content: "summary", signature: "signed-on-demand" },
  ]) {
    const reply: History[number] = { role: "assistant", content: [summary, { type: "text", text: "Continue" }] };
    const full = [...history, reply];
    const before = JSON.stringify(full);
    expect(historyHash(full)).toBe(historyHash([reply]));
    expect(previousHistoryHash([...full, { role: "user", content: "Next" }])).toBe(historyHash([reply]));
    expect(JSON.stringify(full)).toBe(before);
    expect(historyHash([...full, { role: "assistant", content: [{ type: "compaction", content: "new summary" }] }]))
      .toBe(historyHash([{ role: "assistant", content: [{ type: "compaction", content: "new summary" }] }]));
  }
  const noop: History[number] = { role: "assistant", content: [{ type: "compaction", content: null }] };
  expect(historyHash([...history, noop])).not.toBe(historyHash([noop]));
});

test("CAS survives restart, verifies content addressing, isolates session/account and never saves conversation text", async () => {
  const path = join(await directory(), "cas"), store = new HistoryStore(path);
  await store.put(record);
  const restarted = new HistoryStore(path);
  expect(await restarted.get(record.sessionId, record.accountId, record.historyHash)).toEqual(record);
  expect(await restarted.get("other", record.accountId, record.historyHash)).toBeUndefined();
  expect(await restarted.get(record.sessionId, "other", record.historyHash)).toBeUndefined();
  expect(await restarted.get(record.sessionId, record.accountId, previousHistoryHash([...history, { role: "assistant", content: "unknown" }]))).toBeUndefined();
  const objects = await readdir(join(path, "objects"));
  expect(objects).toHaveLength(1);
  const objectPath = join(path, "objects", objects[0]!);
  const raw = await readFile(objectPath, "utf8");
  expect(sha256(raw)).toBe(objects[0]!);
  expect(raw).toBe(canonical(record));
  expect(raw).not.toContain("Question");
  expect((await stat(objectPath)).mode & 0o777).toBe(0o600);
  expect((await stat(path)).mode & 0o777).toBe(0o700);
  const refs = await readdir(join(path, "refs"));
  expect(await readFile(join(path, "refs", refs[0]!), "utf8")).toBe(objects[0]!);
  await writeFile(objectPath, "broken");
  const warnings: string[] = [];
  expect(await new HistoryStore(path, text => warnings.push(text)).get(record.sessionId, record.accountId, record.historyHash)).toBeUndefined();
  expect(warnings).toHaveLength(1);
});

test("failed disk write keeps memory linkage and warns without failing the response", async () => {
  const path = join(await directory(), "not-a-directory");
  await writeFile(path, "occupied");
  const warnings: string[] = [], store = new HistoryStore(path, text => warnings.push(text));
  await store.put(record);
  expect(await store.get(record.sessionId, record.accountId, record.historyHash)).toEqual(record);
  expect(warnings).toEqual(["History CAS write failed; IDs retained in memory only."]);
});

test("concurrent CAS writers publish complete records; abandoned temp files do not affect recovery", async () => {
  const path = join(await directory(), "cas");
  await Promise.all(Array.from({ length: 8 }, (_, i) => new HistoryStore(path).put({ ...record, messageId: `msg_${i}`, requestId: `req_${i}` })));
  await writeFile(join(path, "refs", "interrupted.tmp"), "partial");
  const value = await new HistoryStore(path).get(record.sessionId, record.accountId, record.historyHash);
  expect(value?.messageId).toMatch(/^msg_[0-7]$/);
  expect(value?.requestId.replace("req_", "")).toBe(value?.messageId.replace("msg_", ""));
});

test("CAS recovers after writer process is killed without shutdown hooks", async () => {
  const path = join(await directory(), "cas");
  const source = `import { HistoryStore } from ${JSON.stringify(join(import.meta.dir, "../src/history-store.ts"))};
    await new HistoryStore(${JSON.stringify(path)}).put(${JSON.stringify(record)});
    process.kill(process.pid, "SIGKILL");`;
  const child = Bun.spawn([process.execPath, "--eval", source], { stdout: "pipe", stderr: "pipe" });
  expect(await child.exited).not.toBe(0);
  expect(await new HistoryStore(path).get(record.sessionId, record.accountId, record.historyHash)).toEqual(record);
});
