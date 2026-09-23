import { randomInt, randomBytes } from "node:crypto";
import { AccountStore } from "./store.ts";
import { Transport, UpstreamError, jsonResponse } from "./transport.ts";
import { AppError, modelsPageSchema, profileSchema, usageSchema, safeAccount, type Tokens, type Usage, type Model, type Account, type Message, type Profile } from "./schema.ts";
import { hasQuota, retryAt } from "./quota.ts";

export class Accounts {
  private usageCache = new Map<string, { until: number; value: Promise<Usage> }>();
  private profileCache = new Map<string, { until: number; value: Promise<Profile> }>();
  private modelsCache = new Map<string, { until: number; value: Promise<Model[]> }>();
  private cooldown = new Map<string, number>();
  private modelCooldown = new Map<string, Map<string, number>>();

  constructor(readonly store = new AccountStore(), readonly transport = new Transport()) {}

  async add(tokens: Tokens, name?: string) {
    const profile = profileSchema.parse(await jsonResponse(await this.transport.request(tokens, "/api/oauth/profile")));
    const id = `${profile.organization.uuid}:${profile.account.uuid}`;
    const account = { ...tokens, id, email: profile.account.email, organizationId: profile.organization.uuid,
      accountUuid: profile.account.uuid, deviceId: randomBytes(32).toString("hex"),
      name: name ?? profile.account.email, disabled: false };
    await this.store.update(data => {
      const index = data.accounts.findIndex(item => item.id === id);
      if (index < 0) data.accounts.push(account);
      else {
        account.deviceId = data.accounts[index]!.deviceId;
        data.accounts[index] = account;
      }
    });
    this.usageCache.delete(id);
    this.profileCache.set(id, { until: Date.now() + 300_000, value: Promise.resolve(profile) });
    this.modelsCache.delete(id);
    this.cooldown.delete(id);
    this.modelCooldown.delete(id);
    return safeAccount(account);
  }

  async token(id: string, rejectedToken?: string) {
    const current = (await this.store.read()).accounts.find(account => account.id === id);
    if (!current || current.disabled) throw new AppError(401, "Account missing or disabled; sign in again");
    const fresh = (account: typeof current) => account.expiresAt > Date.now() + 60_000 &&
      (rejectedToken === undefined || account.accessToken !== rejectedToken);
    if (fresh(current)) return current;
    // Refresh-token rotation must be atomic across requests and CLI/server processes.
    const result = await this.store.update(async data => {
      const account = data.accounts.find(item => item.id === id);
      if (!account || account.disabled) return new AppError(401, "Account requires login");
      if (fresh(account)) return account;
      if (!account.refreshToken) return new AppError(401, "Account requires login: no refresh token");
      try {
        Object.assign(account, await this.transport.refresh(account));
        return account;
      } catch (error) {
        if (error instanceof UpstreamError && (error.code === "invalid_grant" || error.status === 401))
          account.disabled = true;
        // Return the error so the disabled flag is committed before throwing.
        return error instanceof Error ? error : new Error("Token refresh failed");
      }
    });
    if (result instanceof Error) throw result;
    return result;
  }

  private async authenticated(id: string, send: (account: Account) => Promise<Response>) {
    let account = await this.token(id);
    let response = await send(account);
    if (response.status === 401 && account.refreshToken && response.headers.get("x-should-retry") !== "false") {
      await response.body?.cancel();
      account = await this.token(id, account.accessToken);
      response = await send(account);
    }
    return response;
  }

  request(id: string, path: string) {
    return this.authenticated(id, account => this.transport.request(account, path));
  }

  message(id: string, input: Message, sessionId: string, promptId: string, betas: string[], signal: AbortSignal) {
    return this.authenticated(id, account => this.transport.message(account, input, sessionId, promptId, betas, signal));
  }

  usage(id: string, force = false): Promise<Usage> {
    const cached = this.usageCache.get(id);
    if (!force && cached && cached.until > Date.now()) return cached.value;
    const value = this.request(id, "/api/oauth/usage").then(jsonResponse).then(data => usageSchema.parse(data));
    const entry = { until: Date.now() + 30_000, value };
    this.usageCache.set(id, entry);
    value.catch(() => { if (this.usageCache.get(id) === entry) this.usageCache.delete(id); });
    return value;
  }

  profile(id: string): Promise<Profile> {
    const cached = this.profileCache.get(id);
    if (cached && cached.until > Date.now()) return cached.value;
    const value = this.request(id, "/api/oauth/profile").then(jsonResponse).then(data => profileSchema.parse(data));
    const entry = { until: Date.now() + 300_000, value };
    this.profileCache.set(id, entry);
    value.catch(() => { if (this.profileCache.get(id) === entry) this.profileCache.delete(id); });
    return value;
  }

  models(id: string): Promise<Model[]> {
    const cached = this.modelsCache.get(id);
    if (cached && cached.until > Date.now()) return cached.value;
    const value = this.loadModels(id);
    const entry = { until: Date.now() + 300_000, value };
    this.modelsCache.set(id, entry);
    value.catch(() => { if (this.modelsCache.get(id) === entry) this.modelsCache.delete(id); });
    return value;
  }

  private async loadModels(id: string) {
    const models: Model[] = [];
    const cursors = new Set<string>();
    let after: string | undefined;
    for (;;) {
      const query = new URLSearchParams({ limit: "1000", ...(after && { after_id: after }) });
      const page = modelsPageSchema.parse(await jsonResponse(await this.request(id, `/v1/models?${query}`)));
      models.push(...page.data);
      if (!page.has_more) return models;
      if (!page.last_id || cursors.has(page.last_id)) throw new Error("Invalid models pagination");
      after = page.last_id;
      cursors.add(after);
    }
  }

  async choose(model: string, excluded = new Set<string>()) {
    const accounts = (await this.store.read()).accounts.filter(account => !account.disabled && !excluded.has(account.id));
    if (!accounts.length) throw new AppError(503, "No available accounts; run accounts add");
    let failed = false;
    const candidates = await Promise.all(accounts.map(async account => {
      if ((this.cooldown.get(account.id) ?? 0) > Date.now()) return null;
      if ((this.modelCooldown.get(account.id)?.get(model) ?? 0) > Date.now()) return null;
      try {
        const usage = await this.usage(account.id);
        if (!hasQuota(usage, model)) return null;
        const models = await this.models(account.id);
        return models.some(item => item.id === model) ? account.id : null;
      } catch { failed = true; return null; }
    }));
    const eligible = candidates.filter(id => id !== null);
    if (!eligible.length) throw new AppError(failed ? 503 : 429,
      failed ? "Cannot verify account quota or models" : "No account has quota for this model (or model unavailable)");
    return eligible[randomInt(eligible.length)]!;
  }

  limited(id: string, headers: Headers, model?: string) {
    if (model) {
      const windows = this.modelCooldown.get(id) ?? new Map<string, number>();
      windows.set(model, retryAt(headers));
      this.modelCooldown.set(id, windows);
    } else this.cooldown.set(id, retryAt(headers));
    this.usageCache.delete(id);
  }

  async status(force = false) {
    return Promise.all((await this.store.read()).accounts.map(async account => {
      if (account.disabled) return { ...safeAccount(account), usage: null, error: "Login required",
        subscriptionType: null, rateLimitTier: null, seatTier: null };
      const profile = await this.profile(account.id).catch(() => null);
      try { return { ...safeAccount(account), usage: await this.usage(account.id, force),
        subscriptionType: profile?.organization.organization_type ?? null,
        rateLimitTier: profile?.organization.rate_limit_tier ?? null,
        seatTier: profile?.organization.seat_tier ?? null }; }
      catch { return { ...safeAccount(account), usage: null, error: "Cannot load quota; account excluded from selection",
        subscriptionType: profile?.organization.organization_type ?? null,
        rateLimitTier: profile?.organization.rate_limit_tier ?? null,
        seatTier: profile?.organization.seat_tier ?? null }; }
    }));
  }

  async allModels() {
    const accounts = (await this.store.read()).accounts.filter(account => !account.disabled);
    const results = await Promise.allSettled(accounts.map(account => this.models(account.id)));
    const available = results.filter(result => result.status === "fulfilled");
    if (!available.length) throw new AppError(503, "Cannot load models from any account");
    return [...new Map(available.flatMap(result => result.value).map(model => [model.id, model])).values()];
  }

  startRefresh() {
    let running = false;
    const timer = setInterval(async () => {
      if (running) return;
      running = true;
      try {
        const accounts = (await this.store.read()).accounts.filter(account => !account.disabled && account.expiresAt < Date.now() + 60_000);
        for (const account of accounts) {
          try { await this.token(account.id); }
          catch { console.error(`Token refresh failed for ${account.id}; retry on next tick/request`); }
        }
      } catch { console.error("Cannot read account store during refresh"); }
      finally { running = false; }
    }, 30_000);
    timer.unref();
    return () => clearInterval(timer);
  }
}
