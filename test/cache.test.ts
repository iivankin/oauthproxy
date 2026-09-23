import { expect, test } from "bun:test";
import { prepareBody } from "../src/profile.ts";
import type { Message } from "../src/schema.ts";

const base: Message = { model: "test", max_tokens: 64, system: "Custom", messages: [{ role: "user", content: "Hello" }] };
const prepare = (input: Message) => prepareBody(input, { promptId: crypto.randomUUID(), sessionId: crypto.randomUUID(),
  account: { accountUuid: crypto.randomUUID(), deviceId: "a".repeat(64) } });
const normalizedMessages: Message["messages"] = [{ role: "user", content: [{ type: "text", text: "Hello" }] }];

test("default caches identity, custom system and message tail, but not billing", () => {
  const output = prepare(base);
  expect(output.system[0]).not.toHaveProperty("cache_control");
  expect(output.system.slice(1).every(block => JSON.stringify(block.cache_control) === '{"type":"ephemeral","ttl":"1h"}')).toBe(true);
  expect(output.messages[0]!.content).toEqual([{ type: "text", text: "Hello", cache_control: { type: "ephemeral", ttl: "1h" } }]);
  expect(base.messages[0]!.content).toBe("Hello");
});

test("caller breakpoints and TTLs are preserved without adding a fifth marker", () => {
  const system = Array.from({ length: 4 }, (_, i) => ({ type: "text" as const, text: `Block ${i}`, cache_control: { type: "ephemeral", ttl: "5m" } }));
  const output = prepare({ ...base, system });
  expect(output.system.slice(2)).toEqual(system);
  expect(output.system[1]).not.toHaveProperty("cache_control");
  expect(output.messages).toEqual(normalizedMessages);
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
