import { z } from "zod";
import type { Account } from "./schema.ts";
import { CLI_VERSION } from "./profile.ts";

export const FLAGS_PATH = "/api/eval-authed/sdk-zAZezfDKGoZuXXKe";
// Only seed the model-billing flags. Other cached experiments belong to the
// local CLI identity, and native Code deliberately never persists some gates.
const modelFlags = ["tengu_saffron_lattice", "tengu_usage_overage_included_models"] as const;
const featureSchema = z.object({ value: z.unknown(), source: z.string().optional(),
  experiment: z.object({ key: z.string() }).nullish(),
  experimentResult: z.object({ variationId: z.number() }).nullish() });
const responseSchema = z.object({ features: z.record(z.string(), z.unknown()) });

export function flagAttributes(account: Account) {
  return { attributes: { id: account.deviceId, deviceID: account.deviceId,
    accountUUID: account.accountUuid, organizationUUID: account.organizationId,
    sessionId: crypto.randomUUID(), platform: process.platform, userType: "external",
    appVersion: CLI_VERSION, entrypoint: "cli", apiBaseUrlHost: "api.anthropic.com" },
  forcedVariations: {}, forcedFeatures: [], url: "" };
}

export function modelFlagSnapshot(input: unknown) {
  const { features } = responseSchema.parse(input);
  const values: Record<string, unknown> = {};
  const experiments: Record<string, { experimentId: string; variationId: number; value: unknown }> = {};
  for (const key of modelFlags) {
    const feature = featureSchema.parse(features[key]);
    if (feature.value === undefined) throw new Error(`Missing model flag: ${key}`);
    values[key] = feature.value;
    if (feature.source === "experiment" && feature.experiment && feature.experimentResult)
      experiments[key] = { experimentId: feature.experiment.key,
        variationId: feature.experimentResult.variationId, value: feature.value };
  }
  // Reject malformed billing data rather than silently clearing a consent gate.
  z.object({ enabled: z.boolean().optional(), planLimitsEndDate: z.string().optional(),
    overageConsentRequired: z.boolean().optional(), perModel: z.record(z.string(),
    z.object({ enabled: z.boolean() })).optional() }).parse(values.tengu_saffron_lattice);
  z.array(z.string()).parse(values.tengu_usage_overage_included_models);
  return { features: values, experiments, fetchedAt: Date.now() };
}
