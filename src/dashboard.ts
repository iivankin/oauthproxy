import type { Accounts } from "./accounts.ts";
import type { Accounts as CodexAccounts } from "./codex/accounts.ts";
import { dashboardAccounts, type DashboardAccount, type Quota } from "./dashboard-data.ts";
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
    <td>${row.provider}</td><td><span class="status ${row.status === "Connected" ? "ok" : ""}">${escape(row.status)}</span></td>
    <td class="quotas">${row.quotas.map(quota).join("") || "—"}</td></tr>`;
}

export async function dashboard(claude: Accounts, codex: CodexAccounts, stats: Stats) {
  const { accounts, errors } = await dashboardAccounts(claude, codex);
  const counters = stats.snapshot();
  const sum = (key: "total" | "active" | "errors") => counters.reduce((n, row) => n + row[key], 0);
  const rows = counters.map(row => {
    const name = accounts.find(a => a.provider === row.provider && a.id === row.account)?.name ?? row.account;
    return `<tr><td>${escape(name)}</td><td>${row.provider}</td><td>${row.transport}</td>
      <td>${row.total}</td><td>${row.active}</td><td>${row.completed}</td><td>${row.errors}</td><td>${row.cancelled}</td></tr>`;
  }).join("");
  return new Response(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="30"><title>OAuth Proxy</title>
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
@media(max-width:640px){main{padding:24px 16px}.summary{gap:0;justify-content:space-between}.summary strong{font-size:24px}td{padding-right:20px}.quotas{min-width:220px}}
</style></head><body><main>
<header><div><h1>OAuth Proxy</h1><small>${escape(date(new Date().toISOString()))} · Refreshes every 30s</small></div><a href="/dashboard">Refresh</a></header>
<div class="summary"><div><small>Accounts</small><strong>${accounts.length}</strong></div><div><small>HTTP requests / WS sessions</small><strong>${sum("total")}</strong></div><div><small>Active</small><strong>${sum("active")}</strong></div><div><small>Errors</small><strong>${sum("errors")}</strong></div></div>
${errors.map(error => `<p class="error">${escape(error)}</p>`).join("")}
<h2>Accounts &amp; quotas</h2><div class="table"><table><thead><tr><th>Account</th><th>Provider</th><th>Status</th><th>Quota used</th></tr></thead><tbody>
${accounts.map(account).join("") || '<tr><td colspan="4" class="empty">No accounts connected</td></tr>'}</tbody></table></div>
<h2>Traffic</h2><div class="table"><table><thead><tr><th>Account</th><th>Provider</th><th>Transport</th><th>Total</th><th>Active</th><th>Completed</th><th>Errors</th><th>Cancelled</th></tr></thead><tbody>
${rows || '<tr><td colspan="8" class="empty">No traffic yet</td></tr>'}</tbody></table></div>
<footer><small>Since ${escape(date(stats.since.toISOString()))} · In memory · Per-account attempts<br>HTTP: completed 2xx streams, non-2xx / transport errors. WS: connections, not model turns. In-stream model errors are not counted.</small></footer>
</main></body></html>`, { headers: {
    "content-type": "text/html; charset=utf-8", "cache-control": "no-store, no-transform",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
  } });
}
