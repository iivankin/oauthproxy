type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const EXCLUDED = new Set(["max_tokens", "fallbacks", "fallback_credit_token"]);
const SEED = 0x4D659218E32A3268n;

// Current protocol reference: CLIProxyAPI/internal/runtime/executor/claude_signing.go.
// Verified against both native 2.1.280 captures (81109, 087ba). This operates on
// the SDK's canonical JSON.stringify output, not arbitrary hand-formatted JSON.
function hashView(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(hashView).join(",")}]`;
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  const entries = Object.entries(value);
  const kept = entries.filter(([key]) => !EXCLUDED.has(key));
  let trailing = 0;
  for (let i = entries.length - 1; i >= 0 && EXCLUDED.has(entries[i]![0]); i--) trailing++;
  const fields = kept.map(([key, child]) => `${JSON.stringify(key)}:${key === "model" && typeof child === "string" ? '""' : hashView(child)}`);
  // Native normalization leaves a comma when two or more excluded members end
  // a nonempty object. The hash view need not itself be valid JSON.
  return `{${fields.join(",")}${trailing >= 2 && kept.length ? "," : ""}}`;
}

export function signBody(raw: string): string {
  const body: Record<string, Json> = JSON.parse(raw);
  if (JSON.stringify(body) !== raw) throw new Error("CCH requires canonical SDK JSON serialization");
  const system = body.system;
  if (!Array.isArray(system)) throw new Error("Missing billing system block");
  const first = system[0];
  if (!first || typeof first !== "object" || Array.isArray(first) || typeof first.text !== "string" || !first.text.startsWith("x-anthropic-billing-header:"))
    throw new Error("Missing billing text");
  const field = /\bcch=[0-9a-f]{5};/.exec(first.text);
  if (!field) throw new Error("Missing CCH placeholder");
  first.text = first.text.slice(0, field.index + 4) + "00000" + first.text.slice(field.index + 9);
  const unsigned = JSON.stringify(body);
  const cch = (Bun.hash.xxHash64(Buffer.from(hashView(body)), SEED) & 0xfffffn).toString(16).padStart(5, "0");
  // Locate the actual top-level system block, not a lookalike inside user text,
  // tools or nested objects. Everything before it is serialized identically.
  const before = Object.keys(body).slice(0, Object.keys(body).indexOf("system"));
  const prefix = "{" + before.map(key => `${JSON.stringify(key)}:${JSON.stringify(body[key])}`).join(",") + (before.length ? "," : "") + '"system":[';
  const firstRaw = JSON.stringify(first);
  const beforeText = Object.keys(first).slice(0, Object.keys(first).indexOf("text"));
  const textPrefix = "{" + beforeText.map(key => `${JSON.stringify(key)}:${JSON.stringify(first[key])}`).join(",") + (beforeText.length ? "," : "") + '"text":';
  const digits = prefix.length + textPrefix.length + JSON.stringify(first.text).indexOf("cch=00000;") + 4;
  if (!unsigned.startsWith(prefix + firstRaw) || unsigned.slice(digits, digits + 5) !== "00000") throw new Error("CCH offset mismatch");
  return unsigned.slice(0, digits) + cch + unsigned.slice(digits + 5);
}
