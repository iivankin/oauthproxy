import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { dashboardResetsScript } from "../src/dashboard-resets.ts";
import type { ConsumeReset } from "../src/codex/resets.ts";

// Exercise the inline handler across page reloads without sending a real, one-use reset.
function mount(storage: Map<string, string>, post: (path: string, input: ConsumeReset) => Promise<unknown>) {
  const events = new Map<string, () => Promise<void>>();
  const output = { textContent: "" };
  const button = { disabled: true, addEventListener: (name: string, fn: () => Promise<void>) => events.set(name, fn) };
  const options: { value: string; textContent: string; title: string }[] = [];
  const select = { hidden: true, options, get value() { return options[0]?.value; },
    get selectedOptions() { return options.slice(0, 1); },
    replaceChildren() { options.splice(0); }, append(option: typeof options[number]) { options.push(option); } };
  const elements: Record<string, unknown> = { output, button, select, summary: { textContent: "" } };
  const details = { open: true, dataset: { accountId: "local-account", accountLabel: "Test account" },
    querySelector: (selector: string) => elements[selector],
    addEventListener: (name: string, fn: () => Promise<void>) => events.set(name, fn) };
  runInNewContext(dashboardResetsScript, {
    document: { querySelectorAll: () => [details], createElement: () => ({}) },
    token: "proxy-key", busy: false, crypto, confirm: () => true, setTimeout: () => {}, post,
    sessionStorage: { getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    request: async () => ({ available_count: 2, credits: [
      { id: "credit-1", status: "available", title: "Full reset" },
      { id: "spent-credit", status: "redeemed", title: "Spent reset" },
    ] }),
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
