import { createHash } from "node:crypto";
import type { Message } from "./schema.ts";

export type History = Message["messages"];
export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

// Sort object keys, but retain array order and every content value, including
// signatures and tool input fields named cache_control. Only block-level cache
// annotations are excluded below; nothing in the actual request is rewritten.
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, v]) => `${JSON.stringify(key)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}

export function historyHash(history: History): string {
  let normalized: History = [];
  for (const message of history) {
    let content = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
    const boundary = content.findLastIndex(block => block.type === "compaction" && typeof block.content === "string" && block.content.length > 0);
    // Threshold compaction discards everything before its last summary. The same
    // key must work whether the client retains or removes that obsolete prefix.
    // Signed on-demand summaries also become a new root. Null blocks are no-ops.
    if (boundary >= 0) { normalized = []; content = content.slice(boundary); }
    normalized.push({ role: message.role, content: content.map(({ cache_control: _cache, ...block }) => block) });
  }
  return sha256(canonical(normalized));
}

export function previousHistoryHash(history: History): string | undefined {
  const last = history.findLastIndex(message => message.role === "assistant");
  if (last < 0) return undefined;
  // Never fall back to an older assistant: an edited or unknown latest response
  // must not accidentally inherit another branch's diagnostics.
  return historyHash(history.slice(0, last + 1));
}
