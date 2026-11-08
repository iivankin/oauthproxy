import { z } from "zod";

const timestamp = z.string().nullish();
export const claudeResetStatusSchema = z.object({
  cedar_ember: z.object({
    eligible: z.boolean(), ineligible_reason: z.string().nullish(),
    at_limit: z.boolean().default(false), exhausted: z.array(z.string()).default([]),
    cooldown_until: timestamp,
    grants: z.array(z.object({
      id: z.string().regex(/^[a-z0-9_-]{1,40}$/), label: z.string().nullish(),
      resets_left: z.number().int().nonnegative(), clears: z.array(z.string()),
      starts_at: timestamp, ends_at: timestamp, paused: z.boolean().default(false),
      usable_now: z.boolean(), use_requires_limit: z.boolean().default(true),
      blocking: z.array(z.string()).default([]), gives_back_weekly: z.boolean().default(false),
      unavailable_reason: z.string().nullish(),
    })).default([]),
  }).nullish(),
  juniper_tide: z.object({
    eligible: z.boolean(), ineligible_reason: z.string().nullish(),
    available: z.boolean().default(false), arm: z.string().nullish(),
    next_available_at: timestamp,
  }).nullish(),
}).refine(value => value.cedar_ember != null || value.juniper_tide != null, "Missing reset status");

export const claudeConsumeSchema = z.object({
  credit_id: z.string().regex(/^(juniper_tide|cedar_ember:[a-z0-9_-]{1,40})$/),
  redeem_request_id: z.uuid(),
}).strict();
export type ClaudeConsume = z.infer<typeof claudeConsumeSchema>;

export const claudeResetResultSchema = z.object({
  result: z.enum(["reset", "already_used", "not_limited", "cooldown", "ineligible", "unavailable"]),
  reason: z.string().nullish(), cleared: z.array(z.string()).default([]),
  resets_left: z.number().int().nonnegative().nullish(), cooldown_until: timestamp,
  next_available_at: timestamp, weekly_resets_at: timestamp,
});

export function claudeResetOffers(value: unknown, now = Date.now()) {
  const status = claudeResetStatusSchema.parse(value);
  const cedar = status.cedar_ember;
  const credits = (cedar?.grants ?? []).map(grant => {
    const blocked = grant.blocking.length > 0;
    const ends = grant.ends_at ? Date.parse(grant.ends_at) : Infinity;
    const starts = grant.starts_at ? Date.parse(grant.starts_at) : -Infinity;
    const cooling = cedar?.cooldown_until != null && !(Date.parse(cedar.cooldown_until) <= now);
    const atLimit = cedar?.at_limit && cedar.exhausted.some(window =>
      grant.clears.includes(window) || window === "seven_day" && grant.gives_back_weekly);
    const available = cedar?.eligible && grant.usable_now && !grant.paused && !blocked &&
      !cooling && ends > now && starts <= now && (!grant.use_requires_limit || atLimit);
    const reason = !cedar?.eligible ? cedar?.ineligible_reason : grant.paused ? "paused"
      : ends <= now ? "expired" : starts > now ? "not_started" : cooling ? "cooldown"
      : blocked ? `blocked: ${grant.blocking.join(", ")}` : !available ? grant.unavailable_reason ?? "not_offered" : null;
    const scope = grant.clears.map(window => window.replaceAll("_", " ")).join(" + ");
    return { id: `cedar_ember:${grant.id}`, reset_type: "cedar_ember", status: available ? "available" : "unavailable",
      title: grant.label || `${scope || "Usage"} reset`, expires_at: grant.ends_at ?? null,
      available_at: cooling ? cedar?.cooldown_until : null, count: grant.resets_left || Number(available),
      description: [grant.gives_back_weekly ? "Returns Fable usage to the weekly limit" : scope,
        !grant.use_requires_limit ? "Can be used before reaching the limit" : "", reason].filter(Boolean).join(" · ") };
  });
  const juniper = status.juniper_tide;
  if (juniper) {
    // CLI requires the reset experiment arm as well as eligible/available.
    const available = juniper.eligible && juniper.arm === "reset" && juniper.available;
    credits.push({ id: "juniper_tide", reset_type: "juniper_tide", status: available ? "available" : "unavailable",
      title: "5-hour reset (once a week)", expires_at: null, available_at: juniper.next_available_at,
      count: Number(available), description: ["Weekly usage is preserved", juniper.ineligible_reason,
        juniper.arm !== "reset" ? "Not offered for CLI" : !juniper.available ? "Already used or unavailable" : ""].filter(Boolean).join(" · ") });
  }
  return { available_count: credits.filter(credit => credit.status === "available").reduce((sum, credit) => sum + credit.count, 0),
    credits, reason: cedar?.ineligible_reason ?? juniper?.ineligible_reason ?? null };
}
