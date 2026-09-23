import type { Message } from "./schema.ts";

type Prepared = {
  model: string; max_tokens: number; messages: Message["messages"];
  system: Array<{ type: "text"; text: string; [key: string]: unknown }>;
  [key: string]: unknown;
};
const marker = { type: "ephemeral", ttl: "1h" } as const;
const cacheable = new Set(["text", "image", "document", "tool_use", "tool_result"]);
const marked = (block: unknown) => typeof block === "object" && block !== null && "cache_control" in block;

export function applyCaching(body: Prepared): Prepared {
  const explicit = "cache_control" in body || body.system.some(marked) ||
    (Array.isArray(body.tools) && body.tools.some(marked)) ||
    body.messages.some(message => Array.isArray(message.content) && message.content.some(marked));
  // Caller-defined caching owns the entire policy: don't exceed four markers or
  // insert a 1h breakpoint after a caller's 5m one (invalid TTL ordering).
  if (explicit) return body;
  const system = body.system.map(block => ({ ...block }));
  // Billing is block zero. The captured SDK profile marks identity and custom
  // system separately; tools are already part of the cached prefix.
  if (system[1]) system[1].cache_control = { ...marker };
  if (system.length > 2) system.at(-1)!.cache_control = { ...marker };
  const messages = [...body.messages];
  const last = messages.at(-1);
  if (!last) return { ...body, system, messages };
  const content = typeof last.content === "string" ? [{ type: "text", text: last.content }] : [...last.content];
  const index = content.findLastIndex(block => typeof block.type === "string" && cacheable.has(block.type) &&
    (block.type !== "text" || (typeof block.text === "string" && block.text.trim().length > 0)));
  if (index >= 0) {
    content[index] = { ...content[index], cache_control: { ...marker } };
    messages[messages.length - 1] = { ...last, content };
  }
  return { ...body, system, messages };
}
