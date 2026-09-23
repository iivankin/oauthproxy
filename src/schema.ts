import { z } from "zod";

export const tokensSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  expiresAt: z.number().finite().positive(),
  scopes: z.array(z.string()).default([]),
  clientId: z.string().default("9d1c250a-e61b-44d9-88ed-5944d1962f5e"),
});
export const accountSchema = tokensSchema.extend({
  id: z.string().min(1), email: z.string(), organizationId: z.string(),
  accountUuid: z.uuid(), deviceId: z.string().regex(/^[0-9a-f]{64}$/),
  name: z.string(), disabled: z.boolean().default(false),
});
export const storeSchema = z.object({
  version: z.literal(2), accounts: z.array(accountSchema),
});
export type Tokens = z.infer<typeof tokensSchema>;
export type Account = z.infer<typeof accountSchema>;
export type StoreData = z.infer<typeof storeSchema>;

const windowSchema = z.object({
  utilization: z.number().finite().nonnegative().nullable(), resets_at: z.string().nullable(),
  locked_reason: z.string().nullish(),
}).passthrough();
export const usageSchema = z.object({
  // A missing quota is unknown, never assumed to mean unlimited availability.
  five_hour: windowSchema.nullable(), seven_day: windowSchema.nullable(),
  seven_day_opus: windowSchema.nullish(), seven_day_sonnet: windowSchema.nullish(),
  seven_day_oauth_apps: windowSchema.nullish(),
  seven_day_overage_included: windowSchema.nullish(),
}).passthrough();
export type Usage = z.infer<typeof usageSchema>;
export const modelSchema = z.object({ id: z.string(), type: z.string().optional() }).passthrough();
export type Model = z.infer<typeof modelSchema>;
export const modelsPageSchema = z.object({
  data: z.array(modelSchema), has_more: z.boolean().default(false),
  last_id: z.string().nullish(),
});
export const profileSchema = z.object({
  account: z.object({ uuid: z.string(), email: z.string() }),
  organization: z.object({
    uuid: z.string(), organization_type: z.string().nullish(),
    rate_limit_tier: z.string().nullish(), seat_tier: z.string().nullish(),
  }),
});
export type Profile = z.infer<typeof profileSchema>;

export const messageSchema = z.object({
  model: z.string().min(1), max_tokens: z.number().int().positive(),
  messages: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    content: z.union([z.string(), z.array(z.record(z.string(), z.unknown()))]),
  }).passthrough()).min(1),
  system: z.union([z.string(), z.array(z.object({
    type: z.literal("text"), text: z.string(),
  }).passthrough())]).optional(),
  stream: z.boolean().optional(), betas: z.array(z.string()).optional(),
}).passthrough();
export type Message = z.infer<typeof messageSchema>;

export class AppError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function safeAccount(account: Account) {
  return {
    id: account.id, name: account.name, email: account.email,
    organizationId: account.organizationId, expiresAt: account.expiresAt,
    refreshable: Boolean(account.refreshToken), disabled: account.disabled,
  };
}
