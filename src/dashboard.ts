import type { Accounts } from "./accounts.ts";
import type { Accounts as CodexAccounts } from "./codex/accounts.ts";
import { dashboardAccounts, type DashboardAccount, type Quota } from "./dashboard-data.ts";
import { dashboardScript } from "./dashboard-script.ts";
import type { Stats } from "./stats.ts";

const escape = (text: string) => text.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
function date(value: string) {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString().replace("T", " ").slice(0, 16) + " UTC" : "Unknown";
}
function quota(row: Quota) {
  const percent = row.used === null ? "—" : `${Math.round(row.used * 10) / 10}%`;
  return `<div class="quota"><div class="quota-label"><span>${escape(row.label)}</span><span>${percent}${row.blocked ? " · Limited" : ""}</span></div>
    ${row.used === null ? "" : `<progress class="${row.blocked ? "limited" : ""}" max="100" value="${Math.max(0, Math.min(100, row.used))}" aria-label="${escape(row.label)} used"></progress>`}
    ${row.resets ? `<small>Resets ${escape(date(row.resets))}</small>` : ""}</div>`;
}
function account(row: DashboardAccount) {
  return `<tr><td><strong>${escape(row.name)}</strong><small>${escape(row.identity)}</small></td>
    <td>${row.provider}</td><td>${escape(row.tier ?? "—")}</td><td><span class="status ${row.status === "Connected" ? "ok" : ""}">${escape(row.status)}</span></td>
    <td class="quotas">${row.quotas.map(quota).join("") || "—"}</td></tr>`;
}

export async function dashboard(claude: Accounts, codex: CodexAccounts, stats: Stats, key?: string, origin = "http://127.0.0.1:3000") {
  const { accounts, errors } = await dashboardAccounts(claude, codex);
  const counters = stats.snapshot();
  const sum = (key: "total" | "active" | "errors") => counters.reduce((n, row) => n + row[key], 0);
  const rows = counters.map(row => {
    const name = accounts.find(a => a.provider === row.provider && a.id === row.account)?.name ?? row.account;
    return `<tr><td>${escape(name)}</td><td>${row.provider}</td><td>${row.transport}</td>
      <td>${row.total}</td><td>${row.active}</td><td>${row.completed}</td><td>${row.errors}</td><td>${row.cancelled}</td></tr>`;
  }).join("");
  const authorization = `Authorization: Bearer ${key ?? "<PROXY_API_KEY>"}`;
  const claudeRequest = `curl '${origin}/v1/messages' \\
  -H '${authorization}' \\
  -H 'Content-Type: application/json' \\
  -H 'x-claude-code-session-id: 00000000-0000-4000-8000-000000000000' \\
  -d '{"model":"claude-sonnet-5","max_tokens":256,"messages":[{"role":"user","content":"Hello"}]}'`;
  const codexRequest = `curl '${origin}/v1/responses' \\
  -H '${authorization}' \\
  -H 'Content-Type: application/json' \\
  -H 'session-id: example-session' \\
  -d '{"model":"gpt-6-sol","input":[{"role":"user","content":[{"type":"input_text","text":"Hello"}]}],"store":false,"stream":true}'`;
  return new Response(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>OAuth Proxy</title>
<style>
:root{color-scheme:dark;font-family:ui-sans-serif,system-ui,sans-serif;background:#111416;color:#e6eaed;font-size:14px}
*{box-sizing:border-box}body{margin:0}main{max-width:1120px;margin:auto;padding:44px 28px 64px}
header{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-bottom:36px}
h1{font-size:23px;font-weight:600;letter-spacing:-.6px;margin:0}h2{font-size:16px;font-weight:550;margin:36px 0 16px}
a{color:#b2d6c3;text-decoration:none;border:1px solid #37423e;border-radius:5px;padding:8px 13px}a:hover{background:#24322b}
small,.muted{display:block;color:#94a0a9;font-size:12px;line-height:1.6}header small{margin-top:5px}
.summary{display:flex;gap:56px;padding:22px 0;border-top:1px solid #30373b;border-bottom:1px solid #30373b}.summary strong{display:block;font-size:29px;font-weight:500;font-variant-numeric:tabular-nums;margin-top:6px}
.table{overflow-x:auto}table{width:100%;border-collapse:collapse;text-align:left;font-variant-numeric:tabular-nums}th{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#94a0a9;font-weight:500;padding:0 16px 12px 0}td{padding:19px 16px 19px 0;border-top:1px solid #293035;vertical-align:top}td strong{font-weight:550}td small{max-width:280px;overflow-wrap:anywhere}td:first-child{overflow-wrap:anywhere;max-width:300px}
.status{font-size:12px;color:#d8b783;white-space:nowrap}.status.ok{color:#a4d1b9}.quotas{width:37%;min-width:250px}.quota+.quota{margin-top:15px}.quota-label{display:flex;justify-content:space-between;gap:18px;font-size:12px;color:#bec8cf}progress{display:block;width:100%;height:5px;border:0;border-radius:4px;overflow:hidden;margin:8px 0;background:#2b3439;accent-color:#8cbea4}progress::-webkit-progress-bar{background:#2b3439}progress::-webkit-progress-value{background:#8cbea4}progress.limited::-webkit-progress-value{background:#d8a775}.empty{color:#94a0a9;padding:24px 0}.error{color:#d8b783}footer{margin-top:20px}
.connection{display:grid;grid-template-columns:auto 1fr;gap:8px 18px;border-top:1px solid #293035;border-bottom:1px solid #293035;padding:16px 0;margin-bottom:20px}.connection dt{color:#94a0a9}.connection dd{margin:0;overflow-wrap:anywhere}code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}code{color:#c4ddd0}pre{margin:0;padding:16px 0;border-top:1px solid #293035;color:#cbd4d9;line-height:1.55;white-space:pre-wrap;overflow-wrap:anywhere}.examples{display:grid;grid-template-columns:1fr 1fr;gap:28px}.examples h3{font-size:13px;font-weight:550;margin:0 0 10px}
.oauth{display:grid;grid-template-columns:1fr 1fr;gap:28px}.oauth section{border-top:1px solid #293035;padding-top:16px}.oauth h3{font-size:13px;font-weight:550;margin:0 0 14px}.oauth label{display:block;color:#94a0a9;font-size:11px;text-transform:uppercase;letter-spacing:.05em;margin:12px 0 6px}.oauth input{width:100%;border:1px solid #374047;border-radius:4px;background:#151a1d;color:#e6eaed;padding:9px 10px;font:inherit}.actions{display:flex;align-items:center;gap:10px;margin-top:12px}.oauth button{border:1px solid #486052;border-radius:4px;background:#1b2821;color:#c4ddd0;padding:8px 12px;font:inherit;cursor:pointer}.oauth button:disabled{opacity:.45;cursor:default}.oauth a{padding:7px 11px}.oauth output{display:block;min-height:20px;margin-top:10px;color:#a4d1b9;font-size:12px}.oauth output.error{color:#d8b783}.device-code{display:inline-block;margin-top:12px;font-size:18px;letter-spacing:.08em}
@media(max-width:640px){main{padding:24px 16px}.summary{gap:0;justify-content:space-between}.summary strong{font-size:24px}td{padding-right:20px}.quotas{min-width:220px}.examples,.oauth{grid-template-columns:1fr}}
</style></head><body><main data-api-key="${escape(key ?? "")}">
<header><div><h1>OAuth Proxy</h1><small>${escape(date(new Date().toISOString()))} · Refreshes every 30s</small></div><a href="/dashboard">Refresh</a></header>
<div class="summary"><div><small>Accounts</small><strong>${accounts.length}</strong></div><div><small>HTTP requests / WS sessions</small><strong>${sum("total")}</strong></div><div><small>Active</small><strong>${sum("active")}</strong></div><div><small>Errors</small><strong>${sum("errors")}</strong></div></div>
${errors.map(error => `<p class="error">${escape(error)}</p>`).join("")}
<h2>Accounts &amp; quotas</h2><div class="table"><table><thead><tr><th>Account</th><th>Provider</th><th>Plan</th><th>Status</th><th>Quota used</th></tr></thead><tbody>
${accounts.map(account).join("") || '<tr><td colspan="5" class="empty">No accounts connected</td></tr>'}</tbody></table></div>
<h2>Traffic</h2><div class="table"><table><thead><tr><th>Account</th><th>Provider</th><th>Transport</th><th>Total</th><th>Active</th><th>Completed</th><th>Errors</th><th>Cancelled</th></tr></thead><tbody>
${rows || '<tr><td colspan="8" class="empty">No traffic yet</td></tr>'}</tbody></table></div>
<h2>Connect account</h2><div class="oauth">
<section><h3>Claude</h3><label for="claude-account-name">Label</label><input id="claude-account-name" autocomplete="off" placeholder="Optional">
<div class="actions"><button id="claude-oauth-start" type="button">Start OAuth</button><a id="claude-oauth-link" target="_blank" rel="noreferrer" hidden>Open sign-in</a></div>
<label for="claude-oauth-code">Callback code</label><input id="claude-oauth-code" autocomplete="off" placeholder="code#state">
<div class="actions"><button id="claude-oauth-complete" type="button" disabled>Complete OAuth</button></div><output id="claude-oauth-status"></output></section>
<section><h3>Codex</h3><label for="codex-account-name">Label</label><input id="codex-account-name" autocomplete="off" placeholder="Optional">
<div class="actions"><button id="codex-oauth-start" type="button">Start OAuth</button><a id="codex-oauth-link" target="_blank" rel="noreferrer" hidden>Open sign-in</a></div>
<code id="codex-user-code" class="device-code"></code><div class="actions"><button id="codex-oauth-complete" type="button" disabled>Check status</button></div><output id="codex-oauth-status"></output></section>
</div>
<h2>API</h2>
<dl class="connection"><dt>Base URL</dt><dd><code>${escape(origin)}</code></dd><dt>API key</dt><dd><code>${escape(key ?? "Not configured")}</code></dd></dl>
<div class="examples"><section><h3>Claude · POST /v1/messages</h3><pre><code>${escape(claudeRequest)}</code></pre></section>
<section><h3>Codex · POST /v1/responses (SSE)</h3><pre><code>${escape(codexRequest)}</code></pre></section></div>
<pre><code>GET /claude/v1/models     GET /claude/accounts
GET /codex/v1/models      GET /codex/accounts
GET /codex/usage?account=&lt;id&gt;
WS  /v1/responses?model=gpt-6-sol</code></pre>
<footer><small>Since ${escape(date(stats.since.toISOString()))} · In memory · Per-account attempts<br>HTTP: completed 2xx streams, non-2xx / transport errors. WS: connections, not model turns. In-stream model errors are not counted.</small></footer>
</main><script>${dashboardScript}</script></body></html>`, { headers: {
    "content-type": "text/html; charset=utf-8", "cache-control": "no-store, no-transform",
    "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
  } });
}
