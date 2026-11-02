import { z } from "zod";

export const resetSummarySchema = z.object({ available_count: z.number().int().nonnegative() });
export const resetCreditsSchema = resetSummarySchema.extend({
  credits: z.array(z.object({
    id: z.string(), reset_type: z.string(), status: z.string(), granted_at: z.string(),
    expires_at: z.string().nullish(), title: z.string().nullish(), description: z.string().nullish(),
  })),
});
export const consumeResetSchema = z.object({
  redeem_request_id: z.uuid(), credit_id: z.string().min(1).max(1024),
}).strict();
export const consumeResetResultSchema = z.object({
  code: z.enum(["reset", "nothing_to_reset", "no_credit", "already_redeemed"]),
  windows_reset: z.number().int().nonnegative().default(0),
});
export type ConsumeReset = z.infer<typeof consumeResetSchema>;
