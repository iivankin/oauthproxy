import { randomInt } from "node:crypto";
import { AccountStore } from "./store.ts";
import { Transport, UpstreamError } from "./transport.ts";
import { catalogSchema, type Account, type Catalog, type Tokens } from "./types.ts";
import type { Identity } from "./oauth.ts";

export class SelectionError extends Error {}
const permanentRefreshCodes = new Set(["invalid_grant", "invalid_refresh_token", "token_expired",
  "refresh_token_expired", "refresh_token_reused", "refresh_token_invalidated"]);

function permanentRefreshFailure(error: unknown) {
  if (!(error instanceof UpstreamError) || ![400, 401].includes(error.status)) return false;
  try {
    const body = JSON.parse(new TextDecoder().decode(error.body));
    return permanentRefreshCodes.has(typeof body.error === "string" ? body.error : body.error?.code);
  } catch { return false; }
}

export class Accounts {
  private readonly modelCache = new Map<string, { at: number; value: Catalog }>();
  private readonly limitedUntil = new Map<string, number>();
  constructor(readonly store: AccountStore, readonly transport: Transport) {}

  async add(tokens: Tokens, identity: Identity, clientId: string, name?: string) {
    if (!tokens.id_token || !tokens.scope?.split(" ").includes("chatgpt.tokens.use.direct"))
      throw new Error("ChatGPT plan usage was not authorized");
    const account: Account = {
      id: crypto.randomUUID(), name: name ?? "ChatGPT", clientId, subject: identity.subject, email: identity.email,
      accessToken: tokens.access_token, refreshToken: tokens.refresh_token, idToken: tokens.id_token,
      scopes: tokens.scope.split(" "), expiresAt: Date.now() + tokens.expires_in * 1000, disabled: false,
    };
    await this.store.update(data => {
      const previous = data.accounts.find(value => value.clientId === clientId);
      if (previous) {
        if (previous.subject !== identity.subject) throw new Error("OAuth account identity changed");
        account.id = previous.id;
        account.name = name ?? previous.name;
        Object.assign(previous, account);
      } else data.accounts.push(account);
    });
    this.modelCache.delete(account.id);
    this.limitedUntil.delete(account.id);
    return { id: account.id, name: account.name, email: account.email, clientId: account.clientId };
  }

  async token(id: string, rejectedToken?: string): Promise<Account> {
    const current = (await this.store.read()).accounts.find(a => a.id === id);
    if (!current || current.disabled) throw new Error("Account missing or disabled; sign in again");
    if (current.expiresAt > Date.now() + 60_000 && current.accessToken !== rejectedToken) return current;
    const result = await this.store.update(async data => {
      const account = data.accounts.find(a => a.id === id);
      if (!account || account.disabled) return { error: new Error("Account missing or disabled") };
      if (account.expiresAt > Date.now() + 60_000 && account.accessToken !== rejectedToken) return { account };
      try {
        const tokens = await this.transport.refresh(account);
        const granted = tokens.scope?.split(" ") ?? account.scopes;
        if (!granted.includes("chatgpt.tokens.use.direct")) throw new Error("ChatGPT plan permission was revoked");
        account.accessToken = tokens.access_token;
        account.refreshToken = tokens.refresh_token;
        account.expiresAt = Date.now() + tokens.expires_in * 1000;
        account.scopes = granted;
        // The original verified ID token remains the reauthorization hint.
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

  async models(id: string, force = false) {
    const cached = this.modelCache.get(id);
    if (!force && cached && Date.now() - cached.at < 300_000) return cached.value;
    const value = catalogSchema.parse(await this.authorized(id, account => this.transport.models(account)));
    this.modelCache.set(id, { at: Date.now(), value });
    return value;
  }

  async choose(model?: string) {
    const accounts = (await this.store.read()).accounts.filter(account =>
      !account.disabled && (this.limitedUntil.get(account.id) ?? 0) <= Date.now());
    const candidates = await Promise.all(accounts.map(async account => {
      try {
        if (model && !(await this.models(account.id)).models.some(item => item.slug === model)) return undefined;
        return account.id;
      } catch {
        console.warn(`[chatgpt] Cannot verify models for ${account.id}; skipping`);
        return undefined;
      }
    }));
    const eligible = candidates.filter((id): id is string => id !== undefined);
    if (!eligible.length) throw new SelectionError("No ChatGPT account with an available model; check account access and limits");
    return eligible[randomInt(eligible.length)]!;
  }

  limit(id: string, retryAfter?: string | null) {
    const seconds = Number(retryAfter);
    this.limitedUntil.set(id, Date.now() + (Number.isFinite(seconds) && seconds > 0
      ? Math.min(seconds, 86_400) : 1_800) * 1000);
  }

  async status() {
    return (await this.store.read()).accounts.map(({ id, name, clientId, subject, email, expiresAt, disabled }) =>
      ({ id, name, clientId, subject, email, expiresAt, disabled,
        limitedUntil: this.limitedUntil.get(id) ?? null }));
  }

  async catalog() {
    const rows = await this.status();
    const models = new Map<string, Catalog["models"][number]>();
    const errors: { accountId: string; error: string }[] = [];
    await Promise.all(rows.filter(row => !row.disabled).map(async row => {
      try { for (const model of (await this.models(row.id)).models) models.set(model.slug, model); }
      catch { errors.push({ accountId: row.id, error: "Catalog unavailable" }); }
    }));
    return { models: [...models.values()], errors };
  }

  startRefresh() {
    let running = false;
    const timer = setInterval(async () => {
      if (running) return;
      running = true;
      try {
        for (const account of (await this.store.read()).accounts.filter(a => !a.disabled)) {
          try { await this.token(account.id); }
          catch { console.warn(`[chatgpt] Token refresh failed for ${account.id}`); }
        }
      } catch { console.warn("[chatgpt] Cannot read accounts store"); }
      finally { running = false; }
    }, 30_000);
    timer.unref();
    return () => clearInterval(timer);
  }
}
