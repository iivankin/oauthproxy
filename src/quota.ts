import type { Usage } from "./schema.ts";

const sharedClaims = new Set(["five_hour", "seven_day", "seven_day_oauth_apps"]);
const modelClaims = new Set(["seven_day_opus", "seven_day_sonnet", "seven_day_overage_included"]);
export type UsageLimitMode = "extended" | "slow";

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
  const windows = usageLimit === "slow" ? [usage.seven_day, usage.seven_day_oauth_apps]
    : [usage.five_hour, usage.seven_day, usage.seven_day_oauth_apps];
  if (model.includes("opus")) windows.push(usage.seven_day_opus);
  if (model.includes("sonnet")) windows.push(usage.seven_day_sonnet);
  if (model.includes("fable")) windows.push(usage.seven_day_overage_included);
  // Recheck usage after the reset. Do not assume a previously exhausted window has refilled.
  return windows.every(window => !window || (!window.locked_reason && typeof window.utilization === "number" && window.utilization < 100));
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
