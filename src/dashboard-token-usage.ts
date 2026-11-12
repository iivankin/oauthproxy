import type { DashboardAccount } from "./dashboard-data.ts";
import type { TokenUsage } from "./codex/token-usage.ts";
import { aggregateTokenUsage } from "./token-usage-summary.ts";

const escape = (text: string) => text.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const dayMs = 86_400_000;
export const activityViews = ["daily", "weekly", "cumulative"] as const;
type Cell = { date: string; tokens: number; level: number };

export function tokenActivity(buckets: NonNullable<TokenUsage["stats"]>["daily_usage_buckets"], today: string) {
  const end = Date.parse(today);
  const sunday = end - new Date(end).getUTCDay() * dayMs;
  const start = sunday - 51 * 7 * dayMs;
  const totals = new Map<string, number>();
  for (const bucket of buckets) totals.set(bucket.start_date, (totals.get(bucket.start_date) ?? 0) + bucket.tokens);
  const dates = Array.from({ length: 364 }, (_, index) => new Date(start + index * dayMs).toISOString().slice(0, 10));
  const daily = dates.map(date => date <= today ? totals.get(date) ?? 0 : 0);
  const positive = daily.filter(value => value > 0).sort((a, b) => a - b);
  const percentileIndex = (positive.length - 1) * .95;
  const lower = Math.floor(percentileIndex);
  const threshold = positive.length ? positive[lower]! + ((positive[lower + 1] ?? positive[lower]!) - positive[lower]!) * (percentileIndex - lower) : 0;
  const weekly = Array.from({ length: 52 }, (_, index) => daily.slice(index * 7, index * 7 + 7).reduce((a, b) => a + b, 0));
  let total = 0;
  const cumulative = weekly.map(value => total += value);
  const bars = (values: number[]): Cell[] => {
    const max = Math.max(...values);
    return dates.map((_, index) => {
      const week = Math.floor(index / 7), tokens = values[week]!;
      const height = max > 0 && tokens > 0 ? Math.max(1, Math.ceil(tokens / max * 7)) : 0;
      return { date: dates[week * 7]!, tokens, level: 7 - index % 7 <= height ? 4 : 0 };
    });
  };
  // Match ChatGPT: daily colors use p95; weekly/cumulative views are seven-cell bars.
  return {
    daily: dates.map((date, index) => ({ date, tokens: daily[index]!, level: !daily[index] || !threshold ? 0
      : Math.min(4, Math.max(1, Math.ceil(daily[index]! / threshold * 4))) })),
    weekly: bars(weekly), cumulative: bars(cumulative),
  };
}

function metric(label: string, value: number | null | undefined, suffix = "") {
  const title = value == null ? "Unavailable" : `${value.toLocaleString("en")}${suffix}`;
  return `<div><small>${label}</small><strong title="${title}">${value == null ? "—" : compact.format(value) + suffix}</strong></div>`;
}

function duration(seconds: number | null | undefined) {
  if (seconds == null) return "—";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 1) return `${Math.floor(seconds)}s`;
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function tokenUsageSection(accounts: DashboardAccount[], today = new Date().toISOString().slice(0, 10)) {
  const rows = accounts.filter(account => account.provider === "Codex" && account.status !== "Disabled");
  if (!rows.length) return "";
  const summary = aggregateTokenUsage(rows.map(row => row.tokenUsage), today);
  const combined = usageChart("All accounts", summary?.profile, today,
    `${summary?.available ?? 0} / ${rows.length} accounts`, false);
  return `<h2>ChatGPT token activity</h2>${combined}${rows.map(account =>
    usageChart(account.identity || account.name, account.tokenUsage, today)).join("")}`;
}

function usageChart(name: string, profile: TokenUsage | null | undefined, today: string, coverage = "", showStreaks = true) {
    const heading = `<h3>${escape(name)}</h3>${coverage ? `<small>${escape(coverage)}</small>` : ""}`;
    if (!profile?.stats || profile.metadata?.stats_error)
      return `<section class="token-activity">${heading}<small>Token activity unavailable</small></section>`;
    const stats = profile.stats;
    const views = tokenActivity(stats.daily_usage_buckets, today);
    const cells = views.daily.map((cell, index) => `<rect x="${Math.floor(index / 7) * 14}" y="${index % 7 * 14 + 22}" width="10" height="10" rx="2" data-cell="${index}" data-level="${cell.level}"><title>${cell.date}: ${cell.tokens.toLocaleString("en")} tokens</title></rect>`).join("");
    let lastMonth = "";
    const months = views.daily.flatMap((cell, index) => {
      if (index % 7 !== 0 || cell.date.slice(0, 7) === lastMonth) return [];
      lastMonth = cell.date.slice(0, 7);
      const month = new Date(`${cell.date}T00:00:00Z`).toLocaleDateString("en", { month: "short", timeZone: "UTC" });
      return [`<text x="${index / 7 * 14}" y="12">${month}</text>`];
    }).join("");
    return `<section class="token-activity" data-activity="${escape(JSON.stringify(views))}">
      <div class="activity-heading">${heading}<div role="group" aria-label="Token activity view">${activityViews.map(view => `<button type="button" data-view="${view}" aria-pressed="${view === "daily"}">${view[0]!.toUpperCase() + view.slice(1)}</button>`).join("")}</div></div>
      <div class="activity-metrics">${metric("Lifetime tokens", stats.lifetime_tokens)}${metric("Peak daily tokens", stats.peak_daily_tokens)}${showStreaks ? metric("Current streak", stats.current_streak_days, " days") + metric("Longest streak", stats.longest_streak_days, " days") : ""}${metric("Threads", stats.total_threads)}<div><small>Longest task</small><strong>${duration(stats.longest_running_turn_sec)}</strong></div></div>
      <div class="activity-chart"><svg viewBox="0 0 728 120" role="img" aria-label="Daily token activity in UTC">${months}${cells}</svg></div>
      <small>UTC${profile.metadata?.stats_as_of ? ` · As of ${escape(profile.metadata.stats_as_of)}` : ""}</small>
    </section>`;
}

export const tokenUsageStyles = `
.token-activity{border-top:1px solid #293035;padding:18px 0 22px}.activity-heading{display:flex;align-items:center;justify-content:space-between;gap:16px}.activity-heading h3,.token-activity h3{font-size:13px;font-weight:550;margin:0;overflow-wrap:anywhere}.token-activity>h3{margin-bottom:12px}.activity-heading [role=group]{display:flex;gap:4px}.activity-heading button{background:transparent;border:1px solid transparent;color:#94a0a9;border-radius:4px;padding:5px 8px;cursor:pointer}.activity-heading button[aria-pressed=true]{border-color:#486052;color:#c4ddd0;background:#1b2821}.activity-metrics{display:flex;flex-wrap:wrap;gap:18px 36px;margin:18px 0}.activity-metrics strong{display:block;font-size:23px;font-weight:500;font-variant-numeric:tabular-nums}.activity-chart{overflow-x:auto}.activity-chart svg{display:block;width:100%;min-width:600px}.activity-chart text{fill:#94a0a9;font:10px system-ui}.activity-chart rect{fill:#263239}.activity-chart [data-level="1"]{fill:#244c70}.activity-chart [data-level="2"]{fill:#337bab}.activity-chart [data-level="3"]{fill:#56a8e0}.activity-chart [data-level="4"]{fill:#91ceff}.activity-chart rect:hover{stroke:#e6eaed;stroke-width:1}
`;

export const tokenUsageScript = `
  for (const section of document.querySelectorAll("[data-activity]")) {
    const views = JSON.parse(section.dataset.activity);
    for (const button of section.querySelectorAll("[data-view]")) {
      button.addEventListener("click", () => {
        const view = button.dataset.view;
        for (const tab of section.querySelectorAll("[data-view]")) tab.setAttribute("aria-pressed", String(tab === button));
        section.querySelector("svg").setAttribute("aria-label", button.textContent + " token activity in UTC");
        for (const rect of section.querySelectorAll("[data-cell]")) {
          const cell = views[view][Number(rect.dataset.cell)];
          rect.dataset.level = cell.level;
          rect.querySelector("title").textContent = (view === "daily" ? "" : view === "weekly" ? "Week of " : "Through week of ") + cell.date + ": " + cell.tokens.toLocaleString("en") + " tokens";
        }
      });
    }
  }
`;
