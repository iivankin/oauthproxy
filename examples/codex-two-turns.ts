import WebSocket from "ws";

const model = Bun.argv[2];
if (!model) throw new Error("Usage: bun examples/codex-two-turns.ts <model-slug>");
const url = new URL(process.env.PROXY_URL ?? "ws://127.0.0.1:3000/v1/responses");
url.searchParams.set("model", model);
const ws = new WebSocket(url.toString(), { headers: {
  "session-id": crypto.randomUUID(),
  ...(process.env.PROXY_API_KEY && { authorization: `Bearer ${process.env.PROXY_API_KEY}` }),
} });
let turn = 0;
const timeout = setTimeout(() => fail("Timed out"), 120_000);

function fail(message: string) {
  console.error(message);
  process.exitCode = 1;
  clearTimeout(timeout);
  ws.terminate();
}

function send(text: string, previousResponseId?: string) {
  ws.send(JSON.stringify({ type: "response.create", model, instructions: "Answer briefly.",
    input: [{ role: "user", content: [{ type: "input_text", text }] }],
    tools: [], tool_choice: "auto", parallel_tool_calls: true, store: false, stream: true,
    include: ["reasoning.encrypted_content"], ...(previousResponseId && { previous_response_id: previousResponseId }),
  }));
}

ws.on("open", () => send("Remember the word ORBIT. Reply only OK."));
ws.on("message", data => {
  let event;
  try { event = JSON.parse(data.toString()); }
  catch { fail("Non-JSON event"); return; }
  if (event.type === "response.output_text.delta") process.stdout.write(event.delta);
  if (["error", "response.failed", "response.incomplete"].includes(event.type)) { fail(JSON.stringify(event)); return; }
  if (event.type !== "response.completed") return;
  console.log();
  turn++;
  if (turn === 1) {
    if (typeof event.response?.id !== "string") { fail("Completed response has no id"); return; }
    send("What word did I ask you to remember? Reply only that word.", event.response.id);
  } else { clearTimeout(timeout); ws.close(1000, "done"); }
});
ws.on("unexpected-response", (_request, response) => {
  response.resume();
  fail(`HTTP ${response.statusCode}: WebSocket upgrade rejected`);
});
ws.on("error", () => fail("WebSocket transport error"));
ws.on("close", () => { clearTimeout(timeout); if (turn < 2) process.exitCode = 1; });
