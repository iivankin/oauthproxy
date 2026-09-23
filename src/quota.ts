import type { Usage } from "./schema.ts";

const sharedClaims = new Set(["five_hour", "seven_day", "seven_day_oauth_apps"]);
const modelClaims = new Set(["seven_day_opus", "seven_day_sonnet", "seven_day_overage_included"]);

export function exhaustedQuota(response: Response): "account" | "model" | undefined {
  const h = response.headers;
  if (response.status !== 429 || h.get("anthropic-ratelimit-unified-status") !== "rejected") return;
  // Subscription exhaustion with allowed extra usage is not a quota rejection
  // of this request. Generic RPM/TPM 429s and credits_required alone aren't proof.
  const overage = h.get("anthropic-ratelimit-unified-overage-status");
  if (overage === "allowed" || overage === "allowed_warning") return;
  if (["5h", "7d"].some(window => h.get(`anthropic-ratelimit-unified-${window}-status`) === "rejected")) return "account";
  const claim = h.get("anthropic-ratelimit-unified-representative-claim") ?? "";
  if (sharedClaims.has(claim)) return "account";
  if (modelClaims.has(claim) || h.get("anthropic-ratelimit-unified-7d_oi-status") === "rejected") return "model";
}

export function hasQuota(usage: Usage, model = ""): boolean {
  if (!usage.five_hour || !usage.seven_day) return false;
  const windows = [usage.five_hour, usage.seven_day, usage.seven_day_oauth_apps];
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
  const reset = Number(headers.get("anthropic-ratelimit-unified-reset")) * 1000;
  return reset > now ? reset : now + 60_000;
}
