import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Accounts } from "../src/accounts.ts";
import { AccountStore } from "../src/store.ts";
import { Transport } from "../src/transport.ts";
import { handler } from "../src/proxy.ts";
import { FLAGS_PATH, modelFlagSnapshot } from "../src/claude-flags.ts";

const flags = { features: { tengu_saffron_lattice: { value: { enabled: false }, source: "force" },
  tengu_usage_overage_included_models: { value: ["Fable 5.2"], source: "experiment",
    experiment: { key: "rollout" }, experimentResult: { variationId: 2 } },
  unrelated: { value: "private" } } };

test("CLI flags require proxy auth and use refreshed account OAuth and native identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude-flags-"));
  try {
    const store = new AccountStore(join(directory, "accounts.json"));
    await store.update(data => { data.accounts.push({ id: "a", name: "A", email: "a@test.invalid",
      organizationId: "org", accountUuid: crypto.randomUUID(), deviceId: "d".repeat(64),
      accessToken: "old-access", refreshToken: "refresh", expiresAt: Date.now() + 3600_000,
      clientId: "test-client", scopes: [], disabled: false }); });
    const calls: string[] = [];
    const accounts = new Accounts(store, new Transport(async (url, init) => {
      const path = new URL(url).pathname;
      calls.push(path);
      if (path === "/token") return Response.json({ access_token: "new-access", expires_in: 3600 });
      expect(path).toBe(FLAGS_PATH);
      const headers = new Headers(init?.headers);
      expect(headers.get("user-agent")).toBe("claude-cli/2.1.321 (external, cli)");
      expect(headers.get("anthropic-beta")).toBe("oauth-2025-04-20");
      expect(init?.redirect).toBe("error");
      const body = JSON.parse(String(init?.body));
      expect(body.attributes.organizationUUID).toBe("org");
      expect(body.attributes.deviceID).toBe("d".repeat(64));
      if (headers.get("authorization") === "Bearer old-access")
        return Response.json({ error: { type: "authentication_error" } }, { status: 401 });
      expect(headers.get("authorization")).toBe("Bearer new-access");
      return Response.json(flags);
    }, "https://mock.invalid", "https://mock.invalid/token"));
    const handle = handler(accounts, "proxy-key");
    const url = "http://localhost/claude/cli-flags";
    expect((await handle(new Request(url))).status).toBe(401);
    expect(calls).toHaveLength(0);
    const response = await handle(new Request(url, { headers: { authorization: "Bearer proxy-key" } }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text();
    expect(text).not.toContain("private");
    expect(text).not.toContain("access");
    expect(JSON.parse(text).features).toEqual({ tengu_saffron_lattice: { enabled: false },
      tengu_usage_overage_included_models: ["Fable 5.2"] });
    expect(calls).toEqual([FLAGS_PATH, "/token", FLAGS_PATH]);
    expect(JSON.parse(text).experiments.tengu_usage_overage_included_models)
      .toEqual({ experimentId: "rollout", variationId: 2, value: ["Fable 5.2"] });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("missing or malformed billing flags cannot clear the local consent gate", () => {
  expect(() => modelFlagSnapshot({ features: {} })).toThrow();
  expect(() => modelFlagSnapshot({ features: { ...flags.features,
    tengu_saffron_lattice: { value: { enabled: "false" } } } })).toThrow();
});
