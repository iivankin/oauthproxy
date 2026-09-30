import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { storeSchema, type StoreData } from "./types.ts";

export class AccountStore {
  readonly path: string;
  constructor(path = resolve(process.cwd(), "chatgpt-accounts.json")) { this.path = resolve(path); }

  async read(): Promise<StoreData> {
    try { return storeSchema.parse(JSON.parse(await readFile(this.path, "utf8"))); }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return { version: 1, hostId: `urn:uuid:${crypto.randomUUID()}`, accounts: [] };
      throw new Error(`Cannot read valid ChatGPT accounts JSON: ${this.path}`);
    }
  }

  async update<T>(change: (data: StoreData) => T | Promise<T>): Promise<T> {
    const lock = `${this.path}.lock`;
    const deadline = Date.now() + 45_000;
    for (;;) {
      try { await mkdir(lock, { mode: 0o700 }); break; }
      catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
        if (Date.now() >= deadline) throw new Error(`Store locked: ${lock}`);
        await Bun.sleep(50);
      }
    }
    const temporary = `${this.path}.${crypto.randomUUID()}.tmp`;
    try {
      const data = await this.read();
      const result = await change(data);
      await writeFile(temporary, JSON.stringify(storeSchema.parse(data), null, 2) + "\n", { mode: 0o600, flag: "wx" });
      await rename(temporary, this.path);
      return result;
    } finally {
      await rm(temporary, { force: true });
      await rm(lock, { recursive: true });
    }
  }

  async hostId() { return this.update(data => data.hostId); }
}
