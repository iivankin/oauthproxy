import { z } from "zod";
import type { Accounts } from "./accounts.ts";
import type { Accounts as CodexAccounts } from "./codex/accounts.ts";
import type { Usage as CodexUsage } from "./codex/schema.ts";
import type { Provider } from "./stats.ts";

export type Quota = { label: string; used: number | null; resets: string | null; blocked?: boolean };
export type DashboardAccount = {
  provider: Provider; id: string; name: string; identity: string;
  status: string; quotas: Quota[];
};
const windowSchema = z.object({
  used_percent: z.number().finite().nullable().optional(),
  reset_at: z.number().finite().nullable().optional(),
  limit_window_seconds: z.number().positive().optional(),
});

function codexQuotas(usage: CodexUsage): Quota[] {
  const groups = [
    { label: "", limit: usage.rate_limit },
    ...(usage.additional_rate_limits ?? []).map(item => ({ label: item.normal_model_slug ?? "Additional", limit: item.rate_limit })),
  ];
  return groups.flatMap(({ label, limit }) => {
    if (!limit) return [];
    const quotas: Quota[] = [];
    for (const key of ["primary_window", "secondary_window"]) {
      const parsed = windowSchema.safeParse(limit[key]);
      if (!parsed.success) continue;
      const window = parsed.data;
      const hours = window.limit_window_seconds ? window.limit_window_seconds / 3600 : null;
      const duration = hours ? (hours >= 24 ? `${hours / 24}d` : `${hours}h`) : key.replace("_window", "");
      const date = window.reset_at ? new Date(window.reset_at * 1000) : null;
      quotas.push({ label: `${label} ${duration}`.trim(), used: window.used_percent ?? null,
        resets: date && Number.isFinite(date.getTime()) ? date.toISOString() : null, blocked: !limit.allowed });
    }
    return quotas.length ? quotas : [{ label: label || "Quota", used: null, resets: null, blocked: !limit.allowed }];
  });
}

export async function dashboardAccounts(claude: Accounts, codex: CodexAccounts) {
  const errors: string[] = [];
  const [claudeRows, codexRows] = await Promise.all([
    claude.status().then(rows => rows.map((account): DashboardAccount => ({
      provider: "Claude", id: account.id, name: account.name, identity: account.email,
      status: account.disabled ? "Disabled" : "error" in account ? "Quota unavailable" : "Connected",
      quotas: account.usage ? Object.entries(account.usage).flatMap(([label, value]) => {
        const parsed = z.object({ utilization: z.number().finite().nullable(), resets_at: z.string().nullable(), locked_reason: z.string().nullish() }).safeParse(value);
        if (!parsed.success) return [];
        return [{ label: label.replaceAll("_", " "), used: parsed.data.utilization, resets: parsed.data.resets_at,
          blocked: Boolean(parsed.data.locked_reason) || (parsed.data.utilization ?? 0) >= 100 }];
      }) : [],
    }))).catch(() => { errors.push("Claude accounts unavailable"); return []; }),
    codex.status().then(rows => Promise.all(rows.map(async (account): Promise<DashboardAccount> => {
      const row: DashboardAccount = { provider: "Codex", id: account.id, name: account.name,
        identity: account.accountId, status: account.disabled ? "Disabled" : "Connected", quotas: [] };
      if (account.disabled) return row;
      try {
        const usage = await codex.usage(account.id);
        row.quotas = codexQuotas(usage);
        if (!usage.rate_limit) row.status = "Quota unavailable";
        else if (!usage.rate_limit.allowed) row.status = "Quota exhausted";
      } catch { row.status = "Quota unavailable"; }
      return row;
    }))).catch(() => { errors.push("Codex accounts unavailable"); return []; }),
  ]);
  return { accounts: [...claudeRows, ...codexRows], errors };
}
