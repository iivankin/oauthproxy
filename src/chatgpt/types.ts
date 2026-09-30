import { z } from "zod";

export const endpoints = {
  issuer: "https://auth.openai.com",
  authorize: "https://auth.openai.com/api/accounts/authorize",
  token: "https://auth.openai.com/api/accounts/oauth/token",
  jwks: "https://auth.openai.com/.well-known/jwks.json",
  resource: "https://api.openai.com/v1",
  models: "https://api.openai.com/v1/models",
  responses: "https://api.openai.com/v1/responses",
  websocket: "wss://api.openai.com/v1/responses",
};
export type Endpoints = typeof endpoints;
export const scopes = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";

export const tokenSchema = z.object({
  access_token: z.string().min(1), refresh_token: z.string().min(1),
  id_token: z.string().min(1).optional(), scope: z.string().optional(), expires_in: z.number().positive(),
});
export type Tokens = z.infer<typeof tokenSchema>;
export const accountSchema = z.object({
  id: z.string().uuid(), name: z.string(), clientId: z.string().startsWith("oaiapp_"),
  subject: z.string().min(1), email: z.string().optional(),
  accessToken: z.string().min(1), refreshToken: z.string().min(1), idToken: z.string().min(1),
  scopes: z.array(z.string()), expiresAt: z.number().finite(), disabled: z.boolean().default(false),
});
export type Account = z.infer<typeof accountSchema>;
export const storeSchema = z.object({
  version: z.literal(1), hostId: z.string().startsWith("urn:uuid:"), accounts: z.array(accountSchema),
});
export type StoreData = z.infer<typeof storeSchema>;
export const catalogSchema = z.object({
  models: z.array(z.object({ slug: z.string().min(1), visibility: z.string().optional() }).passthrough()),
}).passthrough();
export type Catalog = z.infer<typeof catalogSchema>;
