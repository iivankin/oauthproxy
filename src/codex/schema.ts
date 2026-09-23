import { z } from "zod";

export const tokensSchema = z.object({
  access_token: z.string().min(1), refresh_token: z.string().min(1).optional(),
  id_token: z.string().min(1).optional(), expires_in: z.number().positive().optional(),
});
export type Tokens = z.infer<typeof tokensSchema>;
export const accountSchema = z.object({
  id: z.string().uuid(), name: z.string(), accountId: z.string().min(1),
  accessToken: z.string().min(1), refreshToken: z.string().min(1), idToken: z.string().min(1),
  expiresAt: z.number().finite(), disabled: z.boolean().default(false),
});
export type Account = z.infer<typeof accountSchema>;
export const storeSchema = z.object({ version: z.literal(1), accounts: z.array(accountSchema) });
export type StoreData = z.infer<typeof storeSchema>;

const limitSchema = z.object({ allowed: z.boolean(), limit_reached: z.boolean() }).passthrough();
export const usageSchema = z.object({
  rate_limit: limitSchema.nullish(),
  additional_rate_limits: z.array(z.object({
    normal_model_slug: z.string().nullish(), rate_limit: limitSchema.nullish(),
  }).passthrough()).nullish(),
}).passthrough();
export type Usage = z.infer<typeof usageSchema>;
export const catalogSchema = z.object({
  models: z.array(z.object({ slug: z.string().min(1) }).passthrough()),
}).passthrough();
export type Catalog = z.infer<typeof catalogSchema>;

// Claims are metadata from tokens obtained directly over OAuth TLS, not an auth verifier.
export function claims(token: string): Record<string, unknown> {
  const payload = token.split(".")[1];
  if (!payload) throw new Error("OAuth token has no JWT claims");
  return z.record(z.string(), z.unknown()).parse(JSON.parse(Buffer.from(payload, "base64url").toString()));
}

export function accountFromTokens(tokens: Tokens, name?: string, previous?: Account): Account {
  const idToken = tokens.id_token ?? previous?.idToken;
  const refreshToken = tokens.refresh_token ?? previous?.refreshToken;
  if (!idToken || !refreshToken) throw new Error("OAuth did not return ID/refresh tokens");
  const idClaims = claims(idToken);
  const auth = z.object({ chatgpt_account_id: z.string().min(1) }).parse(idClaims["https://api.openai.com/auth"]);
  if (previous && previous.accountId !== auth.chatgpt_account_id)
    throw new Error("Refreshed token changed account identity");
  const expiresAt = tokens.expires_in ? Date.now() + tokens.expires_in * 1000
    : z.number().positive().parse(claims(tokens.access_token).exp) * 1000;
  return {
    id: previous?.id ?? crypto.randomUUID(), name: name ?? previous?.name ?? "Codex account",
    accountId: auth.chatgpt_account_id, accessToken: tokens.access_token, refreshToken, idToken,
    expiresAt, disabled: false,
  };
}
