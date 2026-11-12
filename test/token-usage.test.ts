import { afterEach, expect, test } from "bun:test";
import { tokenActivity } from "../src/dashboard-token-usage.ts";
import { aggregateTokenUsage } from "../src/token-usage-summary.ts";
import { fixture } from "./codex-fixture.ts";

const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
async function setup() { const f = await fixture(); fixtures.push(f); return f; }
afterEach(async () => { for (const f of fixtures.splice(0)) await f.close(); });

const profile = {
  stats: {
    lifetime_tokens: 69_506_389_375, peak_daily_tokens: 2_746_776_257,
    current_streak_days: 16, longest_streak_days: 48, total_threads: 3284, longest_running_turn_sec: 41723,
    daily_usage_buckets: [{ start_date: "2026-11-12", tokens: 45_892_833 }],
  },
  metadata: { stats_as_of: "2026-11-12", stats_error: null },
};

test("combined usage merges dates, sums totals and threads, and takes the longest task", () => {
  const summary = aggregateTokenUsage([profile, {
    stats: {
      lifetime_tokens: 100, total_threads: 5, peak_daily_tokens: 90,
      longest_running_turn_sec: 60,
      daily_usage_buckets: [
        { start_date: "2026-11-11", tokens: 90 },
        { start_date: "2026-11-12", tokens: 10 },
        { start_date: "2026-11-13", tokens: 999_999_999 },
      ],
    },
    metadata: { stats_as_of: "2026-11-11" },
  }], "2026-11-12");
  expect(summary?.profile.stats).toEqual({
    lifetime_tokens: 69_506_389_475, total_threads: 3289,
    peak_daily_tokens: 45_892_843, longest_running_turn_sec: 41723,
    daily_usage_buckets: [
      { start_date: "2026-11-11", tokens: 90 },
      { start_date: "2026-11-12", tokens: 45_892_843 },
    ],
  });
  expect(summary?.profile.metadata?.stats_as_of).toBe("2026-11-11");
  expect(summary?.available).toBe(2);
});

test("combined usage reports partial coverage and preserves unavailable totals", () => {
  const summary = aggregateTokenUsage([profile, null, { ...profile, metadata: { stats_error: "unavailable" } }], "2026-11-12");
  expect(summary?.available).toBe(1);
  expect(summary?.total).toBe(3);
  expect(summary?.profile.stats?.lifetime_tokens).toBe(profile.stats.lifetime_tokens);
  expect(aggregateTokenUsage([null], "2026-11-12")).toBeNull();
  expect(aggregateTokenUsage([profile, { stats: { daily_usage_buckets: [] } }], "2026-11-12")?.profile.stats?.lifetime_tokens).toBeNull();
});

test("activity groups UTC weeks, fills gaps, excludes future days and accumulates weekly totals", () => {
  const views = tokenActivity([
    { start_date: "2026-11-07", tokens: 10 },
    { start_date: "2026-11-08", tokens: 20 },
    { start_date: "2026-11-12", tokens: 30 },
    { start_date: "2026-11-12", tokens: 5 },
    { start_date: "2026-11-13", tokens: 10_000 },
  ], "2026-11-12");
  expect(views.daily).toHaveLength(364);
  expect(views.daily.find(cell => cell.date === "2026-11-12")).toEqual({ date: "2026-11-12", tokens: 35, level: 4 });
  expect(views.daily.find(cell => cell.date === "2026-11-13")?.tokens).toBe(0);
  expect(views.daily.find(cell => cell.date === "2026-11-11")?.level).toBe(0);
  expect(views.weekly.at(-8)?.tokens).toBe(10);
  expect(views.weekly.at(-1)).toEqual({ date: "2026-11-08", tokens: 55, level: 4 });
  expect(views.cumulative.at(-1)).toEqual({ date: "2026-11-08", tokens: 65, level: 4 });
  expect(views.weekly.slice(-7).filter(cell => cell.level === 4)).toHaveLength(7);
  expect(views.weekly.slice(-14, -7).filter(cell => cell.level === 4)).toHaveLength(2);
  for (const cells of Object.values(tokenActivity([], "2026-11-12")))
    expect(cells.every(cell => cell.level === 0 && cell.tokens === 0)).toBe(true);
});

test("token profile uses account auth, refreshes a rejected token, and caches per account", async () => {
  const f = await setup();
  f.options.onTokenUsage = request => request.headers.get("authorization") === "Bearer a-access"
    ? new Response("unauthorized", { status: 401 }) : Response.json(profile);
  expect((await f.accounts.tokenUsage(f.a.id))?.stats?.lifetime_tokens).toBe(69_506_389_375);
  await f.accounts.tokenUsage(f.a.id);
  const calls = f.calls.filter(call => call.path === "/token-usage");
  expect(calls).toHaveLength(2);
  expect(calls[1]!.headers.authorization).toBe("Bearer a-refreshed");
  expect(calls[1]!.headers["chatgpt-account-id"]).toBe("a");
  await f.accounts.tokenUsage(f.b.id);
  expect(f.calls.filter(call => call.path === "/token-usage")).toHaveLength(3);
});

test("dashboard renders token totals and charts without leaking OAuth credentials", async () => {
  const f = await setup();
  f.options.onTokenUsage = () => Response.json(profile);
  const html = await (await fetch(`${f.url}dashboard`)).text();
  expect(html).toContain("ChatGPT token activity");
  expect(html).toContain("All accounts");
  expect(html).toContain("2 / 2 accounts");
  expect(html).toContain('title="139,012,778,750">139B');
  expect(html).toContain("2026-11-12: 91,785,666 tokens");
  expect(html).toContain('title="69,506,389,375">69.5B');
  expect(html).toContain('title="2,746,776,257">2.7B');
  expect(html).toContain("16 days");
  expect(html).toContain("48 days");
  expect(html).toContain("11h 35m");
  expect(html).toContain('data-view="weekly"');
  expect(html).toContain('data-view="cumulative"');
  expect(html).toContain("2026-11-12: 45,892,833 tokens");
  expect(html).toContain("As of 2026-11-12");
  const inline = html.match(/<script>([\s\S]*?)<\/script>/)![1]!;
  expect(() => new Function(inline)).not.toThrow();
  for (const secret of ["a-access", "b-access", "a-refresh"]) expect(html).not.toContain(secret);
});

test("profile rejection or invalid stats leave account quota and admission intact", async () => {
  const f = await setup();
  f.options.onTokenUsage = request => request.headers.get("authorization") === "Bearer a-access"
    ? new Response("forbidden", { status: 403 })
    : Response.json({ stats: { daily_usage_buckets: [{ start_date: "invalid", tokens: -1 }] } });
  const html = await (await fetch(`${f.url}dashboard`)).text();
  expect(html).toContain("Token activity unavailable");
  expect(html).toContain("0 / 2 accounts");
  expect(html).not.toContain("Quota unavailable");
  expect((await f.accounts.status()).every(account => !account.disabled)).toBe(true);
  expect(await f.accounts.choose()).toBeString();
  await fetch(`${f.url}dashboard`);
  expect(f.calls.filter(call => call.path === "/token-usage")).toHaveLength(2);
});
