import { expect, test } from "bun:test";
import { prepareBody } from "../src/profile.ts";
import type { Message } from "../src/schema.ts";

const base: Message = { model: "test", max_tokens: 64, system: "Custom", messages: [{ role: "user", content: "Hello" }] };
const prepare = (input: Message) => prepareBody(input, { promptId: crypto.randomUUID(), sessionId: crypto.randomUUID(),
  account: { accountUuid: crypto.randomUUID(), deviceId: "a".repeat(64) } });
const normalizedMessages: Message["messages"] = [{ role: "user", content: [{ type: "text", text: "Hello" }] }];

test("default keeps only billing and caller system, caching the system tail and last message", () => {
  const output = prepare(base);
  expect(output.system[0]).not.toHaveProperty("cache_control");
  expect(output.system.slice(1)).toEqual([{ type: "text", text: "Custom", cache_control: { type: "ephemeral", ttl: "1h" } }]);
  const withoutSystem = prepare({ ...base, system: undefined });
  expect(withoutSystem.system).toHaveLength(1);
  expect(withoutSystem.system[0]!.text).toStartWith("x-anthropic-billing-header:");
  expect(withoutSystem.system[0]).not.toHaveProperty("cache_control");
  expect(output.messages[0]!.content).toEqual([{ type: "text", text: "Hello", cache_control: { type: "ephemeral", ttl: "1h" } }]);
  expect(base.messages[0]!.content).toBe("Hello");
});

test("caller breakpoints and TTLs are preserved without adding a fifth marker", () => {
  const system = Array.from({ length: 4 }, (_, i) => ({ type: "text" as const, text: `Block ${i}`, cache_control: { type: "ephemeral", ttl: "5m" } }));
  const output = prepare({ ...base, system });
  expect(output.system.slice(1)).toEqual(system);
  expect(output.system[0]).not.toHaveProperty("cache_control");
  expect(output.messages).toEqual(normalizedMessages);
});

test("CLI billing is replaced without changing its instructions or explicit cache markers", () => {
  const system = [
    { type: "text" as const, text: "x-anthropic-billing-header: cc_version=2.1.303.abc; cch=12345;" },
    { type: "text" as const, text: "You are Claude Code.", cache_control: { type: "ephemeral", ttl: "1h" } },
  ];
  const output = prepare({ ...base, system });
  expect(output.system.filter(block => block.text.startsWith("x-anthropic-billing-header:"))).toHaveLength(1);
  expect(output.system[0]!.text).not.toContain("2.1.303.abc");
  expect(output.system.slice(1)).toEqual(system.slice(1));
  expect(output.messages).toEqual(normalizedMessages);
  expect(system[0]!.text).toContain("cch=12345;");
});

test("tool and top-level caching also suppress automatic breakpoints", () => {
  const tool = { name: "echo", input_schema: { type: "object" }, cache_control: { type: "ephemeral" } };
  for (const extra of [{ tools: [tool] }, { cache_control: { type: "ephemeral" } }]) {
    const output = prepare({ ...base, ...extra });
    expect(output.system.every(block => !("cache_control" in block))).toBe(true);
    expect(output.messages).toEqual(normalizedMessages);
  }
});

test("tool results can be cached; thinking blocks cannot", () => {
  const result = prepare({ ...base, messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_test", content: "OK" }] }] });
  expect(result.messages[0]!.content).toEqual([{ type: "tool_result", tool_use_id: "toolu_test", content: "OK", cache_control: { type: "ephemeral", ttl: "1h" } }]);
  const thinking = [{ type: "thinking", thinking: "opaque", signature: "sig" }];
  expect(prepare({ ...base, messages: [{ role: "assistant", content: thinking }] }).messages[0]!.content).toEqual(thinking);
});
