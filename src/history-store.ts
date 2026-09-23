import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { canonical, sha256 } from "./history.ts";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const recordSchema = z.object({
  version: z.literal(1), sessionId: z.string(), accountId: z.string(), historyHash: digest,
  messageId: z.string().regex(/^msg_[A-Za-z0-9_-]+$/),
  requestId: z.string().regex(/^req_[A-Za-z0-9_-]{1,36}$/),
});
export type HistoryRecord = z.infer<typeof recordSchema>;

async function atomicWrite(path: string, data: string) {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
    const directory = await open(dirname(path), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await rm(temporary, { force: true }); }
}

export class HistoryStore {
  private memory = new Map<string, HistoryRecord>();
  constructor(readonly directory = resolve(process.cwd(), ".claude-proxy-cas"),
    private warn: (message: string) => void = console.warn) {}

  private key(sessionId: string, accountId: string, historyHash: string) {
    return sha256(canonical({ sessionId, accountId, historyHash }));
  }

  private remember(key: string, value: HistoryRecord) {
    this.memory.delete(key);
    this.memory.set(key, value);
    if (this.memory.size > 1024) this.memory.delete(this.memory.keys().next().value!);
  }

  async get(sessionId: string, accountId: string, historyHash: string | undefined): Promise<HistoryRecord | undefined> {
    if (!historyHash) return undefined;
    const key = this.key(sessionId, accountId, historyHash);
    const cached = this.memory.get(key);
    if (cached) { this.remember(key, cached); return cached; }
    try {
      const address = digest.parse(await readFile(join(this.directory, "refs", key), "utf8"));
      const raw = await readFile(join(this.directory, "objects", address), "utf8");
      if (sha256(raw) !== address) throw new Error("CAS checksum mismatch");
      const value = recordSchema.parse(JSON.parse(raw));
      if (value.sessionId !== sessionId || value.accountId !== accountId || value.historyHash !== historyHash)
        throw new Error("CAS binding mismatch");
      this.remember(key, value);
      return value;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
        this.warn("History CAS read failed; previous IDs omitted.");
      return undefined;
    }
  }

  async put(record: HistoryRecord): Promise<void> {
    const value = recordSchema.parse(record);
    const key = this.key(value.sessionId, value.accountId, value.historyHash);
    this.remember(key, value);
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await Promise.all(["objects", "refs"].map(name => mkdir(join(this.directory, name), { mode: 0o700, recursive: true })));
      const raw = canonical(value), address = sha256(raw);
      // Publish a complete, synced CAS object before its atomic lookup reference.
      // Concurrent identical-history replies may replace the ref; either points
      // to a complete valid response with exactly the same conversation content.
      await atomicWrite(join(this.directory, "objects", address), raw);
      await atomicWrite(join(this.directory, "refs", key), address);
    } catch {
      this.warn("History CAS write failed; IDs retained in memory only.");
    }
  }
}
