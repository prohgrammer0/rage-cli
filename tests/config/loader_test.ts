import { assertEquals, assertRejects } from "@std/assert";
import { loadConfig } from "../../src/config/loader.ts";

Deno.test("loadConfig - loads default config without user overrides", async () => {
  const config = await loadConfig({});

  assertEquals(config.database.path, "./data/rage.db");
  assertEquals(config.ingest.chunk_size, 512);
  assertEquals(config.ingest.chunk_overlap, 64);
  assertEquals(config.ingest.extensions, [".md"]);
  assertEquals(config.models.embedding.model, "nomic-embed-text:latest");
  assertEquals(config.models.embedding.dimensions, 768);
  assertEquals(config.models.line_edit.default, "minimax-m2.5");
  assertEquals(config.models.line_edit.top_k, 10);
  assertEquals(config.models.developmental.default, "kimi-k2.5");
  assertEquals(config.models.developmental.top_k, 40);
  assertEquals(config.ollama.base_url, "http://localhost:11434");
  assertEquals(config.zen.api_key_env, "RAGE_ZEN_API_KEY");
  assertEquals(config.zen.base_url, "https://opencode.ai/zen/v1");
});

Deno.test("loadConfig - applies vaultPaths CLI override", async () => {
  const config = await loadConfig({ vaultPaths: ["/my/vault"] });
  assertEquals(config.vaults.length, 1);
  assertEquals(config.vaults[0].path, "/my/vault");
  assertEquals(config.vaults[0].name, "vault");
});

Deno.test("loadConfig - applies modelLine CLI override", async () => {
  const config = await loadConfig({ modelLine: "gemma3:4b" });
  assertEquals(config.models.line_edit.default, "gemma3:4b");
});

Deno.test("loadConfig - applies modelDev CLI override", async () => {
  const config = await loadConfig({ modelDev: "kimi-k2.5" });
  assertEquals(config.models.developmental.default, "kimi-k2.5");
});

Deno.test("loadConfig - RAGE_VAULT_PATH env var overrides config", async () => {
  Deno.env.set("RAGE_VAULT_PATH", "/env/vault");
  try {
    const config = await loadConfig({});
    assertEquals(config.vaults.length, 1);
    assertEquals(config.vaults[0].path, "/env/vault");
  } finally {
    Deno.env.delete("RAGE_VAULT_PATH");
  }
});

Deno.test("loadConfig - RAGE_VAULT_PATHS env var sets multiple vaults", async () => {
  Deno.env.set("RAGE_VAULT_PATHS", "/vault/a,/vault/b");
  try {
    const config = await loadConfig({});
    assertEquals(config.vaults.length, 2);
    assertEquals(config.vaults[0].path, "/vault/a");
    assertEquals(config.vaults[0].name, "a");
    assertEquals(config.vaults[1].path, "/vault/b");
    assertEquals(config.vaults[1].name, "b");
  } finally {
    Deno.env.delete("RAGE_VAULT_PATHS");
  }
});

Deno.test("loadConfig - RAGE_DB_PATH env var overrides config", async () => {
  Deno.env.set("RAGE_DB_PATH", "/tmp/test.db");
  try {
    const config = await loadConfig({});
    assertEquals(config.database.path, "/tmp/test.db");
  } finally {
    Deno.env.delete("RAGE_DB_PATH");
  }
});

Deno.test("loadConfig - env var takes precedence over CLI override for vault", async () => {
  Deno.env.set("RAGE_VAULT_PATH", "/env/vault");
  try {
    const config = await loadConfig({ vaultPaths: ["/cli/vault"] });
    // Env vars are applied after CLI overrides, so env wins.
    assertEquals(config.vaults[0].path, "/env/vault");
  } finally {
    Deno.env.delete("RAGE_VAULT_PATH");
  }
});

Deno.test("loadConfig - merges user config file on top of defaults", async () => {
  const tmpFile = await Deno.makeTempFile({ suffix: ".toml" });
  try {
    await Deno.writeTextFile(
      tmpFile,
      `
[[vaults]]
path = "/custom/vault"
name = "custom"

[ingest]
chunk_size = 256
`,
    );

    const config = await loadConfig({ configPath: tmpFile });
    assertEquals(config.vaults.length, 1);
    assertEquals(config.vaults[0].path, "/custom/vault");
    assertEquals(config.ingest.chunk_size, 256);
    // Unchanged fields still come from defaults.
    assertEquals(config.ingest.chunk_overlap, 64);
    assertEquals(config.models.embedding.model, "nomic-embed-text:latest");
  } finally {
    await Deno.remove(tmpFile);
  }
});

Deno.test("loadConfig - user config arrays replace defaults (not concatenate)", async () => {
  const tmpFile = await Deno.makeTempFile({ suffix: ".toml" });
  try {
    await Deno.writeTextFile(
      tmpFile,
      `
[ingest]
extensions = [".md", ".txt"]
`,
    );

    const config = await loadConfig({ configPath: tmpFile });
    assertEquals(config.ingest.extensions, [".md", ".txt"]);
  } finally {
    await Deno.remove(tmpFile);
  }
});

Deno.test("loadConfig - throws if user config file does not exist", async () => {
  await assertRejects(
    () => loadConfig({ configPath: "/does/not/exist.toml" }),
  );
});

Deno.test("loadConfig - default config has registry with expected local models", async () => {
  const config = await loadConfig({});
  const localRegistry = config.models.registry.local;

  assertEquals(typeof localRegistry["nomic-embed-text:latest"], "object");
  assertEquals(
    localRegistry["nomic-embed-text:latest"].roles.includes("embedding"),
    true,
  );
});

Deno.test("loadConfig - default config has registry with expected cloud models", async () => {
  const config = await loadConfig({});
  const cloudRegistry = config.models.registry.cloud;

  assertEquals(typeof cloudRegistry["minimax-m2.5"], "object");
  assertEquals(cloudRegistry["minimax-m2.5"].roles.includes("line_edit"), true);
  assertEquals(typeof cloudRegistry["kimi-k2.5"], "object");
  assertEquals(cloudRegistry["kimi-k2.5"].roles.includes("developmental"), true);
  assertEquals(typeof cloudRegistry["glm-5"], "object");
  assertEquals(cloudRegistry["glm-5"].roles.includes("line_edit"), true);
});
