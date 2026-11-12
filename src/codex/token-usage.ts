import { z } from "zod";

const count = z.number().finite().nonnegative();
const bucket = z.object({
  start_date: z.iso.date(), tokens: count,
});
export const tokenUsageSchema = z.object({
  stats: z.object({
    lifetime_tokens: count.nullish(), peak_daily_tokens: count.nullish(),
    current_streak_days: count.nullish(), longest_streak_days: count.nullish(),
    total_threads: count.nullish(), longest_running_turn_sec: count.nullish(),
    daily_usage_buckets: z.array(bucket),
  }).nullable(),
  metadata: z.object({
    stats_as_of: z.iso.date().nullish(), generated_at: z.string().nullish(),
    stats_error: z.unknown().optional(),
  }).optional(),
});
export type TokenUsage = z.infer<typeof tokenUsageSchema>;
