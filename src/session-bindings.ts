import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const recordSchema = z.object({ version: z.literal(1), provider: z.string(), sessionId: z.string(),
  model: z.string(), accountId: z.string().min(1) });
type RecordValue = z.infer<typeof recordSchema>;

export class SessionBindings {
  private readonly memory = new Map<string, RecordValue>();
  private readonly pending = new Map<string, Promise<unknown>>();

  constructor(readonly directory: string, readonly provider: string) {}

  private key(sessionId: string, model: string) {
    return createHash("sha256").update(JSON.stringify([this.provider, sessionId, model])).digest("hex");
  }

  private async read(key: string, sessionId: string, model: string) {
    const cached = this.memory.get(key);
    if (cached) return cached.accountId;
    try {
      const record = recordSchema.parse(JSON.parse(await readFile(join(this.directory, `${key}.json`), "utf8")));
      if (record.provider !== this.provider || record.sessionId !== sessionId || record.model !== model)
        throw new Error("Session binding identity mismatch");
      this.memory.set(key, record);
      return record.accountId;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      return undefined;
    }
  }

  private async write(key: string, sessionId: string, model: string, accountId: string) {
    const record: RecordValue = { version: 1, provider: this.provider, sessionId, model, accountId };
    this.memory.set(key, record);
    const path = join(this.directory, `${key}.json`);
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(JSON.stringify(record) + "\n"); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, path);
      const directory = await open(this.directory, "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } catch {
      console.warn(`[${this.provider}] Session binding write failed; retained in memory only`);
    } finally { await rm(temporary, { force: true }).catch(() => {}); }
  }

  select(sessionId: string, model: string, choose: (preferredId?: string) => Promise<string>): Promise<string> {
    const key = this.key(sessionId, model);
    // Serialize selection, not generation: concurrent first turns on one server
    // must use the same binding. The directory belongs to one server process.
    const previous = this.pending.get(key) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(async () => {
      const preferred = await this.read(key, sessionId, model);
      const accountId = await choose(preferred);
      if (accountId !== preferred) await this.write(key, sessionId, model, accountId);
      return accountId;
    });
    this.pending.set(key, result);
    void result.finally(() => { if (this.pending.get(key) === result) this.pending.delete(key); }).catch(() => {});
    return result;
  }
}
