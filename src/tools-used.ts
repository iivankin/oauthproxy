import type { Message } from "./schema.ts";

const INCOMPLETE = "unreadable-tools-used-before-summary";
const MAX_COUNT = 64;
const MAX_BYTES = 7168;
const VALID_NAME = /^[A-Za-z0-9_.:-]{1,256}$/;

// Claude Code tracks tools across its own compactions. Stateless API clients
// supply only visible history, so mark summaries/truncation instead of claiming
// that a partial list is complete. Filesystem/MCP provenance is harness-only.
export function toolsUsedHeader(messages: Message["messages"]): string {
  const names = new Set<string>();
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === "compaction") names.add(INCOMPLETE);
      if (message.role === "assistant" && (block.type === "tool_use" || block.type === "server_tool_use") &&
        typeof block.name === "string" && block.name.length)
        names.add(VALID_NAME.test(block.name) ? block.name : INCOMPLETE);
    }
  }
  const serialized = [...names].filter(name => name !== INCOMPLETE).map(name => JSON.stringify({ name }));
  const marker = JSON.stringify({ name: INCOMPLETE });
  if (!names.has(INCOMPLETE) && serialized.length <= MAX_COUNT && serialized.join(",").length + 2 <= MAX_BYTES)
    return `[${serialized.join(",")}]`;
  const kept = [marker];
  let bytes = marker.length + 2;
  for (const entry of serialized) {
    if (kept.length === MAX_COUNT || bytes + entry.length + 1 > MAX_BYTES) break;
    kept.push(entry);
    bytes += entry.length + 1;
  }
  return `[${kept.join(",")}]`;
}
