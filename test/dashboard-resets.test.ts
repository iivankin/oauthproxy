import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { dashboardResetsScript } from "../src/dashboard-resets.ts";
import type { ConsumeReset } from "../src/codex/resets.ts";
import { dashboardTimeScript } from "../src/dashboard-time.ts";

// Exercise the inline handler across page reloads without sending a real, one-use reset.
const listing = { available_count: 2, credits: [
  { id: "credit-1", status: "available", title: "Full reset", expires_at: "2026-11-10T10:30:00Z" },
  { id: "spent-credit", status: "redeemed", title: "Spent reset" },
] };
function mount(storage: Map<string, string>, post: (path: string, input: ConsumeReset) => Promise<unknown>,
  provider = "codex", data = listing) {
  const events = new Map<string, () => Promise<void>>();
  const output = { textContent: "" };
  const button = { disabled: true, addEventListener: (name: string, fn: () => Promise<void>) => events.set(name, fn) };
  const options: { value: string; textContent: string; title: string; disabled: boolean }[] = [];
  let selected = "";
  const select = { hidden: true, options, get value() { return selected || options[0]?.value; },
    set value(value: string | undefined) { selected = value ?? ""; }, addEventListener() {},
    get selectedOptions() { return options.filter(option => option.value === this.value); },
    replaceChildren() { options.splice(0); }, append(option: typeof options[number]) { options.push(option); } };
  const elements: Record<string, unknown> = { output, button, select, summary: { textContent: "" } };
  const details = { open: true, dataset: { provider, accountId: "local-account", accountLabel: "Test account" },
    querySelector: (selector: string) => elements[selector],
    addEventListener: (name: string, fn: () => Promise<void>) => events.set(name, fn) };
  runInNewContext(dashboardTimeScript + dashboardResetsScript, {
    document: { querySelectorAll: (selector: string) => selector === ".reset-credits" ? [details] : [], createElement: () => ({}) },
    token: "proxy-key", busy: false, crypto, confirm: () => true, setTimeout: () => {}, post,
    sessionStorage: { getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    request: async () => data,
  });
  return { output, button, select, open: () => events.get("toggle")!(), apply: () => events.get("click")!() };
}

test("dashboard retries an ambiguous reset with the same operation ID after a reload", async () => {
  const storage = new Map<string, string>();
  const calls: ConsumeReset[] = [];
  const first = mount(storage, async (_path, input) => { calls.push(input); throw new Error("Network error"); });
  await first.open();
  expect(first.select.options.map(option => option.value)).toEqual(["credit-1"]);
  await first.apply();
  expect(first.output.textContent).toBe("Network error");
  expect(first.button.disabled).toBe(false);
  expect(storage.size).toBe(1);

  const reloaded = mount(storage, async (_path, input) => { calls.push(input); return { code: "reset", windows_reset: 2 }; });
  await reloaded.open();
  await reloaded.apply();
  expect(calls[0]!.redeem_request_id).toMatch(/^[0-9a-f-]{36}$/);
  expect(calls[1]).toEqual(calls[0]);
  expect(reloaded.output.textContent).toBe("Usage reset applied (2 windows)");
  expect(reloaded.button.disabled).toBe(true);
  expect(storage.size).toBe(0);
});

test("Claude dashboard cannot apply unavailable offers and routes an offered reset to Claude", async () => {
  const calls: string[] = [];
  const post = async (path: string) => { calls.push(path); return { code: "reset" }; };
  const unavailable = mount(new Map(), post, "claude", { available_count: 0, credits: [
    { id: "juniper_tide", status: "unavailable", title: "5-hour reset" },
  ] });
  await unavailable.open();
  expect(unavailable.select.options[0]!.disabled).toBe(true);
  expect(unavailable.button.disabled).toBe(true);
  await unavailable.apply();
  expect(calls).toHaveLength(0);

  const offered = mount(new Map(), post, "claude", { available_count: 1, credits: [
    { id: "juniper_tide", status: "unavailable", title: "5-hour reset" },
    { id: "cedar_ember:grant", status: "available", title: "Full reset" },
  ] });
  await offered.open();
  expect(offered.select.value).toBe("cedar_ember:grant");
  await offered.apply();
  expect(calls).toEqual(["/admin/claude/accounts/local-account/reset-credits/consume"]);
  expect(offered.output.textContent).toBe("Usage reset applied");
});

test("dashboard timestamps use the browser timezone, including daylight saving time", async () => {
  const source = `
    import { runInNewContext } from "node:vm";
    import { dashboardTimeScript } from ${JSON.stringify(new URL("../src/dashboard-time.ts", import.meta.url).pathname)};
    const times = ["2026-01-10T10:30:00Z", "2026-07-10T10:30:00Z"].map(dateTime => ({dateTime}));
    const result = runInNewContext(dashboardTimeScript + 'localTime("2026-11-10T10:30:00Z")', {
      document: { querySelectorAll: () => times },
    });
    console.log(JSON.stringify({times, result}));
  `;
  const child = Bun.spawn([process.execPath, "-e", source], {
    env: { ...process.env, TZ: "America/New_York", LANG: "en_US.UTF-8" }, stdout: "pipe", stderr: "pipe",
  });
  const result = await new Response(child.stdout).json();
  expect(await child.exited).toBe(0);
  expect(result.times[0].textContent).toContain("05:30");
  expect(result.times[1].textContent).toContain("06:30");
  expect(result.result).toContain("05:30");
  expect(result.result).not.toContain("10:30");
});
