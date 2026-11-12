import type { TokenUsage } from "./codex/token-usage.ts";

type UsageStats = NonNullable<TokenUsage["stats"]>;

export function aggregateTokenUsage(profiles: Array<TokenUsage | null | undefined>, today: string) {
  const available = profiles.filter((profile): profile is TokenUsage & { stats: UsageStats } =>
    Boolean(profile?.stats && !profile.metadata?.stats_error));
  if (!available.length) return null;
  const days = new Map<string, number>();
  for (const { stats } of available) {
    for (const bucket of stats.daily_usage_buckets) {
      if (bucket.start_date > today) continue;
      days.set(bucket.start_date, (days.get(bucket.start_date) ?? 0) + bucket.tokens);
    }
  }
  // Account peaks may fall on different days: the combined peak comes from merged daily usage.
  const buckets = [...days].sort(([a], [b]) => a.localeCompare(b))
    .map(([start_date, tokens]) => ({ start_date, tokens }));
  const sum = (key: "lifetime_tokens" | "total_threads") =>
    available.some(profile => profile.stats[key] == null) ? null
      : available.reduce((total, profile) => total + profile.stats[key]!, 0);
  const durations = available.flatMap(profile => profile.stats.longest_running_turn_sec == null
    ? [] : [profile.stats.longest_running_turn_sec]);
  const dates = available.flatMap(profile => profile.metadata?.stats_as_of ? [profile.metadata.stats_as_of] : []);
  const profile: TokenUsage = {
    stats: {
      lifetime_tokens: sum("lifetime_tokens"), total_threads: sum("total_threads"),
      daily_usage_buckets: buckets,
      peak_daily_tokens: buckets.length ? Math.max(...buckets.map(bucket => bucket.tokens)) : null,
      longest_running_turn_sec: durations.length ? Math.max(...durations) : null,
    },
    metadata: { stats_as_of: dates.length === available.length ? dates.sort()[0] : null },
  };
  return { profile, available: available.length, total: profiles.length };
}
