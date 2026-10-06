type ObjectValue = Record<string, unknown>;

function object(value: unknown): ObjectValue {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as ObjectValue : {};
}

function field(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => object(current)[key], value);
}

function id(value: unknown): string | undefined {
  if (typeof value !== "string" || /\p{Cc}/u.test(value)) return;
  const trimmed = value.trim();
  if (trimmed && Buffer.byteLength(trimmed) <= 256) return trimmed;
}

function json(value: unknown): ObjectValue {
  if (typeof value !== "string") return {};
  try { return object(JSON.parse(value)); } catch { return {}; }
}

// Match CLIProxyAPI's explicit-ID priority, without its history-based guesses.
// Keep the raw ID so moving it from body to a response/next-request header
// does not change the binding. Provider and model are namespaced by the store.
export function sessionId(headers: Headers, payload?: unknown): string | undefined {
  const root = object(payload);
  const nested = object(root.request);
  const bodyField = (path: string) => field(root, path) ?? (!root.contents ? field(nested, path) : undefined);
  const firstBody = (paths: string[]) => paths.map(path => id(bodyField(path))).find(Boolean);
  const firstHeader = (names: string[]) => names.map(name => id(headers.get(name))).find(Boolean);
  const userId = bodyField("metadata.user_id");
  const claudeMetadata = json(userId);
  const claudeSession = id(claudeMetadata.session_id) ??
    (typeof userId === "string" ? id(userId.match(/_session_([a-f0-9-]+)$/)?.[1]) : undefined);

  const claude = firstHeader(["x-claude-code-session-id"]) ?? claudeSession;
  if (claude) return claude;
  const codex = firstHeader(["session-id", "session_id"]);
  const turnMetadata = json(headers.get("x-codex-turn-metadata"));
  const codexSession = codex ?? id(turnMetadata.session_id);
  if (codexSession) return codexSession;
  const thread = firstHeader(["thread-id", "thread_id"]) ?? id(turnMetadata.thread_id);
  if (thread) return thread;
  const generic = firstHeader([
    "x-http-session-id", "x-session-id", "x-session-affinity", "x-slot-session-id",
    "x-task-id", "x-task_id", "x-conversation-id", "x-thread-id", "x-client-request-id",
  ]);
  if (generic) return generic;
  const explicitBody = firstBody([
    "cachedContent", "cached_content", "thread_id", "threadId", "metadata.thread_id",
    "session_id", "sessionId", "sessionID", "child_session_id", "childSessionId",
    "metadata.session_id", "metadata.sessionId", "metadata.sessionID", "metadata.child_session_id",
    "extra_body.session_id", "extra_body.sessionId", "extra_body.sessionID",
    "task_id", "taskId", "taskID", "action_id", "actionId", "actionID",
    "metadata.task_id", "metadata.taskId", "metadata.taskID", "metadata.action_id", "metadata.actionId", "metadata.actionID",
    "extra_body.task_id", "extra_body.taskId", "extra_body.taskID", "prompt_cache_key", "promptCacheKey",
  ]);
  if (explicitBody) return explicitBody;
  const conversation = bodyField("conversation");
  return id(object(conversation).id) ?? id(conversation) ?? id(userId) ?? firstBody([
    "conversation_id", "conversationId", "chat_id", "chatId", "metadata.conversation_id", "extra_body.conversation_id",
  ]);
}

export const MISSING_SESSION = "A session ID is required; send session-id, x-claude-code-session-id or a supported body ID";
