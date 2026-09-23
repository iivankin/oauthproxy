import { createHash } from "node:crypto";
import type { Message, Account } from "./schema.ts";
import { applyCaching } from "./cache.ts";

// Matched to the inspected Claude Code 2.1.280 / Agent SDK 0.3.280 build.
export const CLI_VERSION = "2.1.280";
export const USER_AGENT = `claude-cli/${CLI_VERSION} (external, sdk-ts, agent-sdk/0.3.280)`;
export const IDENTITY = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
export const BASE_BETAS = ["oauth-2025-04-20", "interleaved-thinking-2025-05-14", "thinking-token-count-2026-05-13",
  "context-management-2025-06-27", "prompt-caching-scope-2026-01-05", "claude-code-20250219",
  "extended-cache-ttl-2025-04-11", "cache-diagnosis-2026-04-07"];

export type RequestContext = {
  account: Pick<Account, "accountUuid" | "deviceId">; sessionId: string; promptId: string;
  previousRequestId?: string; previousMessageId?: string;
};

export function fingerprint(input: Message): string {
  const content = input.messages.find(message => message.role === "user")?.content;
  const text = typeof content === "string" ? content : content?.find(block => block.type === "text")?.text;
  const prompt = typeof text === "string" ? text : "";
  const picked = [4, 7, 20].map(index => prompt[index] || "0").join("");
  return createHash("sha256").update(`59cf53e54c78${picked}${CLI_VERSION}`).digest("hex").slice(0, 3);
}

export function prepareBody(input: Message, context: RequestContext) {
  const { promptId, previousRequestId, previousMessageId, account, sessionId } = context;
  const { betas: _betas, model, messages, system: _system, tools = [], metadata, max_tokens, thinking,
    temperature, diagnostics: _diagnostics, stream = false, ...extra } = input;
  const previous = previousRequestId && /^req_[A-Za-z0-9_-]{1,36}$/.test(previousRequestId)
    ? ` cc_prev_req=${previousRequestId};` : "";
  // CCH is finalized over the SDK's serialized body in the fetch wrapper.
  const billing = `x-anthropic-billing-header: cc_version=${CLI_VERSION}.${fingerprint(input)}; cc_entrypoint=sdk-ts; cch=00000;${previous} cc_prompt_id=${promptId}; cc_turn_origin=sdk;`;
  const system = typeof input.system === "string" ? [{ type: "text" as const, text: input.system }] : [...(input.system ?? [])];
  if (system[0]?.text !== IDENTITY) system.unshift({ type: "text", text: IDENTITY });
  system.unshift({ type: "text", text: billing });
  const userMetadata = typeof metadata === "object" && metadata !== null && !Array.isArray(metadata) ? metadata : {};
  const thinkingEnabled = typeof thinking === "object" && thinking !== null && "type" in thinking && thinking.type !== "disabled";
  // user_id is transport identity, bound to the selected account/session rather
  // than a caller-supplied identity from some other account.
  return applyCaching({ model, messages: messages.map(message => ({ ...message,
    content: typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content })),
    system, tools, metadata: { ...userMetadata, user_id: JSON.stringify({ device_id: account.deviceId, account_uuid: account.accountUuid, session_id: sessionId }) },
    max_tokens, ...(thinking !== undefined && { thinking }),
    ...(temperature !== undefined ? { temperature } : !thinkingEnabled && { temperature: 1 }),
    ...extra, diagnostics: { previous_message_id: previousMessageId ?? null }, stream });
}
