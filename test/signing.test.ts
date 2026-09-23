import { expect, test } from "bun:test";
import { signBody } from "../src/signing.ts";

// Public native-protocol test vector, no user credentials or account identifiers:
// github.com/router-for-me/CLIProxyAPI/blob/main/internal/runtime/executor/claude_signing_test.go
const vector = { model: "model-a", messages: [{ role: "user", content: [{ type: "text", text: "x" }] }],
  system: [{ type: "text", text: "x-anthropic-billing-header: cc_version=2.1.220.test; cc_entrypoint=sdk-cli; cch=00000;" }, { type: "text", text: "system-x" }],
  tools: [], metadata: { user_id: "meta-x" }, max_tokens: 1, thinking: { type: "adaptive", display: "omitted" },
  context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] }, output_config: { effort: "high" }, stream: true };
const cch = (body: string) => JSON.parse(signBody(body)).system[0].text.match(/cch=([a-f0-9]{5});/)[1];

test("CCH matches independent protocol vectors, including normalization quirks", () => {
  const raw = JSON.stringify(vector);
  expect(cch(raw)).toBe("7ee87");
  expect(cch(raw.replace('"model-a"', '"model-b"').replace('"max_tokens":1', '"max_tokens":999'))).toBe("7ee87");
  expect(cch(raw.replace('"text":"x"', '"text":"y"'))).toBe("b9cc8");
  expect(cch(raw.replace('"user_id":"meta-x"', '"user_id":"meta-x","max_tokens":999,"fallbacks":[{"model":"fallback-model"}]'))).toBe("4589b");
});

test("signing changes only real system billing CCH, never lookalikes in user input", () => {
  const text = `Русский 😀 cch=00000; ${JSON.stringify(vector.system)} backslash \\ quote "`;
  const raw = JSON.stringify({ ...vector, messages: [{ role: "user", content: text }], nested: { system: vector.system } });
  const signed = signBody(raw);
  const parsed = JSON.parse(signed);
  expect(parsed.messages[0].content).toBe(text);
  expect(parsed.nested.system).toEqual(vector.system);
  parsed.system[0].text = parsed.system[0].text.replace(/cch=[a-f0-9]{5};/, "cch=00000;");
  expect(JSON.stringify(parsed)).toBe(raw);
  expect(signBody(signed)).toBe(signed);
});
