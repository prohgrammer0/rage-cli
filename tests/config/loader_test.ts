import { assertEquals, assertRejects } from "@std/assert";
import { loadConfig } from "../../src/config/loader.ts";

Deno.test("loadConfig - loads default config without user overrides", async () => {
  const config = await loadConfig({});

  assertEquals(config.projects, {});
  assertEquals(config.selected_project, undefined);
  assertEquals(config.context.sources, []);
  assertEquals(config.context.extensions, [".md"]);
  assertEquals(config.context.max_tokens, 180000);
  assertEquals(config.context.cache, true);
  assertEquals(config.sessions.enabled, true);
  assertEquals(config.sessions.path, "./data/sessions.db");
  assertEquals(config.models.line_edit.default, "deepseek-v4-flash");
  assertEquals(config.models.developmental.default, "deepseek-v4-pro");
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

[context]
max_tokens = 256
`,
    );

    const config = await loadConfig({ configPath: tmpFile });
    assertEquals(config.vaults.length, 1);
    assertEquals(config.vaults[0].path, "/custom/vault");
    assertEquals(config.context.max_tokens, 256);
    // Unchanged fields still come from defaults.
    assertEquals(config.context.cache, true);
    assertEquals(config.models.line_edit.default, "deepseek-v4-flash");
  } finally {
    await Deno.remove(tmpFile);
  }
});

Deno.test("loadConfig - reads context source entries from user config", async () => {
  const tmpFile = await Deno.makeTempFile({ suffix: ".toml" });
  try {
    await Deno.writeTextFile(
      tmpFile,
      `
[[context.sources]]
path = "/notes/personal.md"
name = "personal.md"

[[context.sources]]
path = "/notes/work/**/*.md"
name = "work"
`,
    );

    const config = await loadConfig({ configPath: tmpFile });
    assertEquals(config.context.sources, [
      { path: "/notes/personal.md", name: "personal.md" },
      { path: "/notes/work/**/*.md", name: "work" },
    ]);
  } finally {
    await Deno.remove(tmpFile);
  }
});

Deno.test("loadConfig - selects project profile from CLI override", async () => {
  const tmpFile = await Deno.makeTempFile({ suffix: ".toml" });
  try {
    await Deno.writeTextFile(
      tmpFile,
      `
[[vaults]]
path = "/custom/vault"
name = "custom"

[[context.sources]]
path = "/global/source"
name = "global"

[projects.blog]
sources = [{ path = "/notes/blog", name = "blog" }]
`,
    );

    const config = await loadConfig({
      configPath: tmpFile,
      project: "blog",
    });
    assertEquals(config.selected_project, "blog");
    assertEquals(config.vaults, []);
    assertEquals(config.context.sources, [
      { path: "/notes/blog", name: "blog" },
    ]);
  } finally {
    await Deno.remove(tmpFile);
  }
});

Deno.test("loadConfig - RAGE_PROJECT env var selects project profile", async () => {
  const tmpFile = await Deno.makeTempFile({ suffix: ".toml" });
  Deno.env.set("RAGE_PROJECT", "mid");
  try {
    await Deno.writeTextFile(
      tmpFile,
      `
[projects.mid]
sources = [{ path = "/notes/mid", name = "mid" }]
`,
    );

    const config = await loadConfig({ configPath: tmpFile });
    assertEquals(config.selected_project, "mid");
    assertEquals(config.context.sources, [
      { path: "/notes/mid", name: "mid" },
    ]);
  } finally {
    Deno.env.delete("RAGE_PROJECT");
    await Deno.remove(tmpFile);
  }
});

Deno.test("loadConfig - RAGE_SESSION_DB_PATH overrides session path", async () => {
  Deno.env.set("RAGE_SESSION_DB_PATH", "/tmp/rage-sessions.db");
  try {
    const config = await loadConfig({});
    assertEquals(config.sessions.path, "/tmp/rage-sessions.db");
  } finally {
    Deno.env.delete("RAGE_SESSION_DB_PATH");
  }
});

Deno.test("loadConfig - throws when selected project is missing", async () => {
  const tmpFile = await Deno.makeTempFile({ suffix: ".toml" });
  try {
    await Deno.writeTextFile(
      tmpFile,
      `
[projects.blog]
sources = [{ path = "/notes/blog", name = "blog" }]
`,
    );

    await assertRejects(
      () => loadConfig({ configPath: tmpFile, project: "missing" }),
      Error,
      `Project "missing" is not configured. Available projects: blog.`,
    );
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
[context]
extensions = [".md", ".txt"]
`,
    );

    const config = await loadConfig({ configPath: tmpFile });
    assertEquals(config.context.extensions, [".md", ".txt"]);
  } finally {
    await Deno.remove(tmpFile);
  }
});

Deno.test("loadConfig - throws if user config file does not exist", async () => {
  await assertRejects(
    () => loadConfig({ configPath: "/does/not/exist.toml" }),
  );
});

Deno.test("loadConfig - default config has registry with expected cloud models", async () => {
  const config = await loadConfig({});
  const cloudRegistry = config.models.registry.cloud;

  assertEquals(typeof cloudRegistry["gemini-3.5-flash"], "object");
  assertEquals(
    cloudRegistry["gemini-3.5-flash"].roles.includes("line_edit"),
    true,
  );
  assertEquals(typeof cloudRegistry["claude-opus-4-8"], "object");
  assertEquals(
    cloudRegistry["claude-opus-4-8"].roles.includes("developmental"),
    true,
  );
  assertEquals(typeof cloudRegistry["glm-5.2"], "object");
  assertEquals(typeof cloudRegistry["kimi-k2.6"], "object");
  assertEquals(typeof cloudRegistry["minimax-m2.7"], "object");
  assertEquals(typeof cloudRegistry["gpt-5.5-pro"], "object");
  assertEquals(cloudRegistry["gpt-5.5-pro"].roles.includes("line_edit"), true);
});
