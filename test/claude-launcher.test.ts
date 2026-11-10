import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const launcher = new URL("../scripts/claude-proxy", import.meta.url).pathname;
const flags = { features: { tengu_saffron_lattice: { enabled: false },
  tengu_usage_overage_included_models: ["Fable 5.2"] }, experiments: {}, fetchedAt: Date.now() };

test("launcher refreshes the native catalog before exec and keeps OAuth auth and arguments", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude-launcher-"));
  const bin = join(directory, "bin");
  await mkdir(bin);
  const configPath = join(directory, ".claude.json");
  await writeFile(configPath, JSON.stringify({ oauthAccount: { accountUuid: "keep-me" },
    cachedGrowthBookFeaturesAt: 123, cachedGrowthBookFeatures: { unrelated: true, tengu_saffron_lattice: { enabled: true } },
    cachedExperimentData: { tengu_saffron_lattice: { experimentId: "stale", variationId: 1, value: true },
      unrelated: { experimentId: "keep", variationId: 0, value: true } } }));
  await writeFile(join(bin, "claude"), `#!/usr/bin/env bun
console.log(JSON.stringify({args:process.argv.slice(2),token:process.env.CLAUDE_CODE_OAUTH_TOKEN,
  genericAuth:process.env.ANTHROPIC_AUTH_TOKEN,apiKey:process.env.ANTHROPIC_API_KEY,
  discovery:process.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY}));`, { mode: 0o700 });
  let requests = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    requests++;
    expect(request.headers.get("authorization")).toBe("Bearer test-oauth");
    const path = new URL(request.url).pathname;
    if (path === "/claude/cli-flags") return Response.json(flags);
    expect(path).toBe("/v1/models");
    return Response.json({ data: [{ id: "claude-fable-5-2", display_name: "Claude Fable 5.2" }, { id: "unrelated-model" }] });
  } });
  try {
    const child = Bun.spawn([launcher, "--resume", "session with spaces"], { env: { ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH}`, CLAUDE_CONFIG_DIR: directory,
      ANTHROPIC_BASE_URL: server.url.origin, CLAUDE_CODE_OAUTH_TOKEN: "test-oauth",
      ANTHROPIC_AUTH_TOKEN: "old-generic", ANTHROPIC_API_KEY: "old-key" }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ stderr, code }).toEqual({ stderr: "", code: 0 });
    expect(JSON.parse(stdout)).toEqual({ args: ["--resume", "session with spaces"], token: "test-oauth", discovery: "1" });
    const path = join(directory, "cache/gateway-models.json");
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ baseUrl: server.url.origin,
      models: [{ id: "claude-fable-5-2", display_name: "Claude Fable 5.2" }] });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(requests).toBe(2);
    const config = JSON.parse(await readFile(configPath, "utf8"));
    expect(config.oauthAccount).toEqual({ accountUuid: "keep-me" });
    expect(config.cachedGrowthBookFeatures).toEqual({ unrelated: true, ...flags.features });
    expect(config.cachedExperimentFeatures).toEqual(["unrelated"]);
    expect(config.cachedExperimentData.tengu_saffron_lattice).toBeUndefined();
    expect(config.cachedGrowthBookFeaturesAt).toBe(123);
    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
  } finally { server.stop(true); await rm(directory, { recursive: true, force: true }); }
});

test("failed discovery keeps the old cache and does not launch Claude", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude-launcher-failure-"));
  const path = join(directory, "cache/gateway-models.json");
  await mkdir(join(directory, "cache"));
  await writeFile(path, "old-cache");
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request =>
    Response.json(new URL(request.url).pathname === "/claude/cli-flags" ? flags : { data: [] }) });
  try {
    const child = Bun.spawn([launcher], { env: { ...process.env, CLAUDE_CONFIG_DIR: directory,
      ANTHROPIC_BASE_URL: server.url.origin, CLAUDE_CODE_OAUTH_TOKEN: "test-oauth" }, stdout: "pipe", stderr: "pipe" });
    const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    expect(code).toBe(1);
    expect(stderr).toContain("Model catalog contains no Claude models");
    expect(await readFile(path, "utf8")).toBe("old-cache");
  } finally { server.stop(true); await rm(directory, { recursive: true, force: true }); }
});

test("failed flag refresh leaves both native caches intact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude-launcher-flags-failure-"));
  const config = join(directory, ".claude.json");
  const catalog = join(directory, "cache/gateway-models.json");
  await mkdir(join(directory, "cache"));
  await writeFile(config, '{"cachedGrowthBookFeatures":{"tengu_saffron_lattice":{"enabled":true}}}');
  await writeFile(catalog, "old-catalog");
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request =>
    new URL(request.url).pathname === "/claude/cli-flags"
      ? new Response("unavailable", { status: 502 })
      : Response.json({ data: [{ id: "claude-fable-5-2" }] }) });
  try {
    const child = Bun.spawn([launcher], { env: { ...process.env, CLAUDE_CONFIG_DIR: directory,
      ANTHROPIC_BASE_URL: server.url.origin, CLAUDE_CODE_OAUTH_TOKEN: "test-oauth" }, stdout: "pipe", stderr: "pipe" });
    const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    expect(code).toBe(1);
    expect(stderr).toContain("/claude/cli-flags returned HTTP 502");
    expect(await readFile(catalog, "utf8")).toBe("old-catalog");
    expect(JSON.parse(await readFile(config, "utf8")).cachedGrowthBookFeatures.tengu_saffron_lattice.enabled).toBe(true);
  } finally { server.stop(true); await rm(directory, { recursive: true, force: true }); }
});
