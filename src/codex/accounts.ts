import { randomInt } from "node:crypto";
import { AccountStore } from "./store.ts";
import { Transport, UpstreamError } from "./transport.ts";
import { accountFromTokens, catalogSchema, usageSchema, type Account, type Catalog, type Tokens, type Usage } from "./schema.ts";

export class SelectionError extends Error {}
const permanentRefreshCodes = new Set(["invalid_grant", "refresh_token_expired", "refresh_token_reused", "refresh_token_invalidated"]);

function permanentRefreshFailure(error: unknown) {
  if (!(error instanceof UpstreamError) || ![400, 401].includes(error.status)) return false;
  try {
    const body = JSON.parse(new TextDecoder().decode(error.body));
    return permanentRefreshCodes.has(typeof body.error === "string" ? body.error : body.error?.code);
  } catch { return false; }
}

export function usageAllowed(usage: Usage, model?: string) {
  // Percent is rounded presentation data; allowed is the backend's admission decision.
  if (usage.rate_limit?.allowed !== true) return false;
  return !model || !(usage.additional_rate_limits ?? []).some(limit =>
    limit.normal_model_slug === model && limit.rate_limit?.allowed === false);
}

export class Accounts {
  private readonly usageCache = new Map<string, { at: number; value: Usage }>();
  private readonly modelCache = new Map<string, { at: number; value: Catalog }>();
  constructor(readonly store: AccountStore, readonly transport: Transport) {}

  async add(tokens: Tokens, name?: string) {
    const account = accountFromTokens(tokens, name);
    await this.store.update(data => {
      const existing = data.accounts.find(a => a.accountId === account.accountId);
      if (existing) {
        account.id = existing.id;
        account.name = name ?? existing.name;
        Object.assign(existing, account);
      } else data.accounts.push(account);
    });
    this.usageCache.delete(account.id);
    this.modelCache.delete(account.id);
    return { id: account.id, name: account.name, accountId: account.accountId };
  }

  async token(id: string, rejectedToken?: string): Promise<Account> {
    const current = (await this.store.read()).accounts.find(a => a.id === id);
    if (!current || current.disabled) throw new Error("Account missing or disabled; sign in again");
    if (current.expiresAt > Date.now() + 60_000 && current.accessToken !== rejectedToken) return current;
    const result = await this.store.update(async data => {
      const account = data.accounts.find(a => a.id === id);
      if (!account || account.disabled) return { error: new Error("Account missing or disabled") };
      // Recheck after acquiring the cross-process lock: another process may have rotated it.
      if (account.expiresAt > Date.now() + 60_000 && account.accessToken !== rejectedToken) return { account };
      try {
        const updated = accountFromTokens(await this.transport.refresh(account.refreshToken), undefined, account);
        Object.assign(account, updated);
        return { account };
      } catch (error) {
        if (permanentRefreshFailure(error)) account.disabled = true;
        return { error };
      }
    });
    if ("error" in result) throw result.error;
    return result.account;
  }

  async authorized<T>(id: string, call: (account: Account) => Promise<T>): Promise<T> {
    const account = await this.token(id);
    try { return await call(account); }
    catch (error) {
      if (!(error instanceof UpstreamError) || error.status !== 401) throw error;
      return call(await this.token(id, account.accessToken));
    }
  }

  async usage(id: string, force = false) {
    const cached = this.usageCache.get(id);
    if (!force && cached && Date.now() - cached.at < 30_000) return cached.value;
    const value = usageSchema.parse(await this.authorized(id, account => this.transport.get(this.transport.endpoints.usage, account)));
    this.usageCache.set(id, { at: Date.now(), value });
    return value;
  }

  async models(id: string, force = false) {
    const cached = this.modelCache.get(id);
    if (!force && cached && Date.now() - cached.at < 300_000) return cached.value;
    const url = new URL(this.transport.endpoints.models);
    url.searchParams.set("client_version", this.transport.version);
    const value = catalogSchema.parse(await this.authorized(id, account => this.transport.get(url.toString(), account)));
    this.modelCache.set(id, { at: Date.now(), value });
    return value;
  }

  async choose(model?: string) {
    const accounts = (await this.store.read()).accounts.filter(account => !account.disabled);
    const candidates = await Promise.all(accounts.map(async account => {
      try {
        if (!usageAllowed(await this.usage(account.id), model)) return undefined;
        if (model && !(await this.models(account.id)).models.some(m => m.slug === model)) return undefined;
        return account.id;
      } catch {
        console.warn(`[accounts] Cannot verify quota/model for ${account.id}; skipping`);
        return undefined;
      }
    }));
    const eligible = candidates.filter((id): id is string => id !== undefined);
    if (!eligible.length) throw new SelectionError("No account with verified available quota/model; check accounts usage");
    return eligible[randomInt(eligible.length)]!;
  }

  invalidateUsage(id: string) { this.usageCache.delete(id); }

  async status() {
    return (await this.store.read()).accounts.map(({ id, name, accountId, expiresAt, disabled }) =>
      ({ id, name, accountId, expiresAt, disabled }));
  }

  startRefresh() {
    let running = false;
    const timer = setInterval(async () => {
      if (running) return;
      running = true;
      try {
        for (const account of (await this.store.read()).accounts.filter(a => !a.disabled)) {
          try { await this.token(account.id); }
          catch { console.warn(`[codex] Token refresh failed for ${account.id}; login may be required`); }
        }
      } catch { console.warn("[codex] Cannot read accounts store"); }
      finally { running = false; }
    }, 30_000);
    timer.unref();
    return () => clearInterval(timer);
  }

  async catalog() {
    const accounts = (await this.store.read()).accounts.filter(a => !a.disabled);
    const models = new Map<string, Catalog["models"][number]>();
    const errors: { accountId: string; error: string }[] = [];
    await Promise.all(accounts.map(async account => {
      try { for (const model of (await this.models(account.id)).models) models.set(model.slug, model); }
      catch { errors.push({ accountId: account.id, error: "Catalog unavailable" }); }
    }));
    return { models: [...models.values()].sort((a, b) => a.slug.localeCompare(b.slug)), errors };
  }
}
