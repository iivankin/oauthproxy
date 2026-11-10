import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readConfig(path: string): Promise<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!record(value)) throw new Error("Invalid Claude config");
    return value;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
    throw error;
  }
}

async function atomicJson(path: string, data: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(data), { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

async function refresh() {
  const baseUrl = process.env.ANTHROPIC_BASE_URL!;
  const root = baseUrl.replace(/\/+$/, "");
  async function get(path: string) {
    const response = await fetch(`${root}${path}`, {
      headers: { authorization: `Bearer ${process.env.CLAUDE_CODE_OAUTH_TOKEN}`,
        "anthropic-version": "2023-06-01" },
      redirect: "error", signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
    const data: unknown = await response.json();
    if (!record(data)) throw new Error(`Invalid response from ${path}`);
    return data;
  }
  const [catalog, flags] = await Promise.all([get("/v1/models?limit=1000"), get("/claude/cli-flags")]);
  if (!Array.isArray(catalog.data)) throw new Error("Invalid model catalog");
  const models = catalog.data.filter(record).filter(model => typeof model.id === "string" && /claude|anthropic/i.test(model.id))
    .map(model => ({ id: model.id,
      ...(typeof model.display_name === "string" && { display_name: model.display_name }),
      ...(typeof model.description === "string" && { description: model.description }) }));
  if (!models.length) throw new Error("Model catalog contains no Claude models");
  if (!record(flags.features) || !record(flags.experiments) || typeof flags.fetchedAt !== "number" ||
    !record(flags.features.tengu_saffron_lattice) || !Array.isArray(flags.features.tengu_usage_overage_included_models))
    throw new Error("Invalid model billing flags");

  // Native 2.1.321 ignores the OAuth env token during discovery, and its flag
  // service uses a fixed Anthropic host. Seed only the two model-billing flags.
  const configDir = resolve(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"));
  const configPath = join(process.env.CLAUDE_CONFIG_DIR ? configDir : homedir(), ".claude.json");
  const config = await readConfig(configPath);
  const values = record(config.cachedGrowthBookFeatures) ? config.cachedGrowthBookFeatures : {};
  const experiments = record(config.cachedExperimentData) ? { ...config.cachedExperimentData } : {};
  for (const key of Object.keys(flags.features)) delete experiments[key];
  Object.assign(experiments, flags.experiments);
  // Keep the original full-cache timestamp: refreshing two flags does not make
  // the remaining locally cached experiments fresh.
  await atomicJson(configPath, { ...config, cachedGrowthBookFeatures: { ...values, ...flags.features },
    cachedExperimentData: experiments, cachedExperimentFeatures: Object.keys(experiments).sort() });
  await atomicJson(join(configDir, "cache/gateway-models.json"), { baseUrl, fetchedAt: Date.now(), models });
}

await refresh().catch((error: unknown) => {
  console.error(`[claude-proxy] ${error instanceof Error ? error.message : "Discovery failed"}`);
  process.exit(1);
});
