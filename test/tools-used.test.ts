import { expect, test } from "bun:test";
import { toolsUsedHeader } from "../src/tools-used.ts";

test("tools-used follows executed history without claiming harness provenance", () => {
  expect(toolsUsedHeader([{ role: "user", content: "Use Bash" }])).toBe("[]");
  expect(toolsUsedHeader([
    { role: "assistant", content: [{ type: "tool_use", name: "Bash", id: "toolu_a", input: {} },
      { type: "tool_use", name: "mcp__test__echo", id: "toolu_b", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_a", content: "done" }] },
    { role: "assistant", content: [{ type: "tool_use", name: "Bash", id: "toolu_c", input: {} }] },
  ])).toBe('[{"name":"Bash"},{"name":"mcp__test__echo"}]');
});

test("tools-used marks unknown compacted history and respects native count/byte limits", () => {
  const marker = { name: "unreadable-tools-used-before-summary" };
  expect(JSON.parse(toolsUsedHeader([{ role: "assistant", content: [{ type: "compaction", content: "summary" }] }]))).toEqual([marker]);
  for (const size of [10, 256]) {
    const header = toolsUsedHeader([{ role: "assistant", content: Array.from({ length: 100 }, (_, index) => ({
      type: "tool_use", name: `${index}`.padEnd(size, "x"),
    })) }]);
    expect(JSON.parse(header)[0]).toEqual(marker);
    expect(JSON.parse(header).length).toBeLessThanOrEqual(64);
    expect(Buffer.byteLength(header)).toBeLessThanOrEqual(7168);
  }
  expect(JSON.parse(toolsUsedHeader([{ role: "assistant", content: [{ type: "tool_use", name: "invalid\r\nname" }] }]))).toEqual([marker]);
});
