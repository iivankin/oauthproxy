import { AppError } from "./schema.ts";
import { claudeResetOffers, claudeResetResultSchema, type ClaudeConsume } from "./claude-reset-schema.ts";

type Pending = { input: ClaudeConsume; at: number };
type Call = (id: string, path: string, body?: Record<string, string>) => Promise<unknown>;

export class ClaudeResets {
  private readonly pending = new Map<string, Pending>();
  private readonly running = new Set<string>();
  constructor(private readonly call: Call, private readonly invalidate: (id: string) => void) {}

  async list(id: string) {
    return claudeResetOffers(await this.call(id, "/api/oauth/usage?at_wall=1&skip_spend=1"));
  }

  forget(id: string) { this.pending.delete(id); }

  async consume(id: string, input: ClaudeConsume, organizationId: string) {
    if (this.running.has(id)) throw new AppError(409, "A reset is already in progress for this account");
    this.running.add(id);
    try {
      const previous = this.pending.get(id);
      const pending = previous && Date.now() - previous.at < 600_000 ? previous : undefined;
      if (!pending) this.pending.delete(id);
      if (pending && (pending.input.credit_id !== input.credit_id || pending.input.redeem_request_id !== input.redeem_request_id))
        throw new AppError(409, "Previous reset is unconfirmed; retry it with the same redeem_request_id");
      if (!pending) {
        const offers = await this.list(id);
        if (!offers.credits.some(credit => credit.id === input.credit_id && credit.status === "available"))
          throw new AppError(409, "This reset is not currently offered; refresh reset credits");
      }
      const cedar = input.credit_id.startsWith("cedar_ember:");
      const body: Record<string, string> = cedar ? { program: "cedar_ember", grant_id: input.credit_id.slice("cedar_ember:".length),
        request_id: input.redeem_request_id } : { program: "juniper_tide" };
      // An ambiguous claim must retain its UUID; a new UUID could spend another reset.
      this.pending.set(id, pending ?? { input, at: Date.now() });
      const result = claudeResetResultSchema.parse(await this.call(id,
        `/api/organizations/${encodeURIComponent(organizationId)}/reset_rate_limits`, body));
      if (result.result !== "unavailable" && !(result.result === "cooldown" && pending)) this.pending.delete(id);
      if (["reset", "not_limited"].includes(result.result) || result.cleared.length ||
        result.result === "already_used" && pending) this.invalidate(id);
      return { code: result.result, windows_reset: result.cleared.length, reason: result.reason,
        resets_left: result.resets_left, cooldown_until: result.cooldown_until,
        next_available_at: result.next_available_at, weekly_resets_at: result.weekly_resets_at };
    } finally { this.running.delete(id); }
  }
}
