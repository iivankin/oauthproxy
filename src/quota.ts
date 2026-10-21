import type { Usage } from "./schema.ts";

const sharedClaims = new Set(["five_hour", "seven_day", "seven_day_oauth_apps"]);
const modelClaims = new Set(["seven_day_opus", "seven_day_sonnet", "seven_day_overage_included"]);
export type UsageLimitMode = "extended" | "slow";
export type QuotaReset = { at: number; claim: string };
type WindowClaim = "five_hour" | "seven_day" | "seven_day_oauth_apps" |
  "seven_day_opus" | "seven_day_sonnet" | "seven_day_overage_included";

function quotaWindows(usage: Usage, model: string, mode?: UsageLimitMode) {
  if (mode === "extended") return [];
  const claims: WindowClaim[] = mode === "slow" ? ["seven_day", "seven_day_oauth_apps"]
    : ["five_hour", "seven_day", "seven_day_oauth_apps"];
  if (model.includes("opus")) claims.push("seven_day_opus");
  if (model.includes("sonnet")) claims.push("seven_day_sonnet");
  if (model.includes("fable")) claims.push("seven_day_overage_included");
  return claims.map(claim => ({ claim, window: usage[claim] }));
}

export function exhaustedQuota(response: Response): "account" | "model" | undefined {
  const h = response.headers;
  if (response.status !== 429) return;
  const slow = h.get("anthropic-ratelimit-unified-slow-status");
  // A slow-lane capacity miss is deliberately retried by Claude Code on the
  // same account. Rotating here would lose the server-side allowance state.
  if (slow === "slot_busy") return;
  if (slow === "weekly_limit" || slow === "budget_exhausted") return "account";
  if (h.get("anthropic-ratelimit-unified-status") !== "rejected") return;
  // Subscription exhaustion with allowed extra usage is not a quota rejection
  // of this request. Generic RPM/TPM 429s and credits_required alone aren't proof.
  const overage = h.get("anthropic-ratelimit-unified-overage-status");
  if (overage === "allowed" || overage === "allowed_warning") return;
  if (["5h", "7d"].some(window => h.get(`anthropic-ratelimit-unified-${window}-status`) === "rejected")) return "account";
  const claim = h.get("anthropic-ratelimit-unified-representative-claim") ?? "";
  if (sharedClaims.has(claim)) return "account";
  if (modelClaims.has(claim) || h.get("anthropic-ratelimit-unified-7d_oi-status") === "rejected") return "model";
}

export function hasQuota(usage: Usage, model = "", usageLimit?: UsageLimitMode): boolean {
  if (!usage.five_hour || !usage.seven_day) return false;
  // `extended` is a server-controlled wrap-up allowance and can cross either
  // the session or weekly boundary. `slow` can cross only the session limit;
  // its weekly limit still applies. The server remains the authority for both.
  if (usageLimit === "extended") return true;
  // Recheck usage after the reset. Do not assume a previously exhausted window has refilled.
  return quotaWindows(usage, model, usageLimit).every(({ window }) =>
    !window || (!window.locked_reason && typeof window.utilization === "number" && window.utilization < 100));
}

export function quotaReset(usage: Usage, model: string, mode?: UsageLimitMode, now = Date.now()): QuotaReset | undefined {
  if (!usage.five_hour || !usage.seven_day) return;
  let latest: QuotaReset | undefined;
  for (const { claim, window } of quotaWindows(usage, model, mode)) {
    if (!window) continue;
    // A lock or unknown utilization need not clear at the advertised reset.
    if (window.locked_reason || typeof window.utilization !== "number") return;
    if (window.utilization < 100) continue;
    const at = Date.parse(window.resets_at ?? "");
    if (!Number.isFinite(at) || at <= now) return;
    if (!latest || at > latest.at) latest = { at, claim };
  }
  return latest;
}

export function responseQuotaReset(headers: Headers, now = Date.now()): QuotaReset | undefined {
  let claim = headers.get("anthropic-ratelimit-unified-representative-claim") ?? "";
  if (!sharedClaims.has(claim) && !modelClaims.has(claim)) {
    if (headers.get("anthropic-ratelimit-unified-7d-status") === "rejected" ||
      headers.get("anthropic-ratelimit-unified-slow-status") === "weekly_limit") claim = "seven_day";
    else if (headers.get("anthropic-ratelimit-unified-5h-status") === "rejected") claim = "five_hour";
    else return;
  }
  const resets = ["anthropic-ratelimit-unified-reset", "anthropic-ratelimit-unified-slow-budget-reset"]
    .map(name => Number(headers.get(name)) * 1000).filter(at => Number.isFinite(at) && at > now);
  // Retry-After is a retry delay, not evidence of a subscription reset.
  if (resets.length) return { at: Math.max(...resets), claim };
}

export function setPoolQuotaHeaders(headers: Headers, reset?: QuotaReset, now = Date.now()) {
  if (!reset || reset.at <= now) return;
  const at = Math.ceil(reset.at / 1000);
  headers.set("anthropic-ratelimit-unified-status", "rejected");
  headers.set("anthropic-ratelimit-unified-reset", String(at));
  headers.set("anthropic-ratelimit-unified-representative-claim", reset.claim);
  headers.set("retry-after", String(Math.ceil((at * 1000 - now) / 1000)));
  // The SDK prefers this header to Retry-After; do not leave a stale account delay.
  if (headers.has("retry-after-ms")) headers.set("retry-after-ms", String(at * 1000 - now));
}

export function retryAt(headers: Headers, now = Date.now()): number {
  const retry = headers.get("retry-after");
  if (retry) {
    const numeric = Number(retry);
    const parsed = Number.isFinite(numeric) ? now + numeric * 1000 : Date.parse(retry);
    if (Number.isFinite(parsed) && parsed > now) return parsed;
  }
  const resets = ["anthropic-ratelimit-unified-reset", "anthropic-ratelimit-unified-slow-budget-reset"]
    .map(name => Number(headers.get(name)) * 1000).filter(value => Number.isFinite(value) && value > now);
  return resets.length ? Math.max(...resets) : now + 60_000;
}
