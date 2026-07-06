import { assertEquals, assertExists } from "@std/assert";
import { createModelRegistry } from "../../src/config/models.ts";
import { loadConfig } from "../../src/config/loader.ts";

async function makeRegistry() {
  const config = await loadConfig({});
  return createModelRegistry(config);
}

const ZEN_MODELS = [
  "gemini-3.5-flash",
  "gemini-3.1-pro",
  "claude-opus-4-8",
  "claude-sonnet-4-6",
  "deepseek-v4-pro",
  "deepseek-v4-flash",
  "glm-5.2",
  "kimi-k2.6",
  "qwen3.6-plus",
  "minimax-m2.7",
  "gpt-5.5-pro",
  "gpt-5.5",
];

// --- initialization ---

Deno.test("ModelRegistry - getAvailable returns empty before initialize", async () => {
  const reg = await makeRegistry();
  assertEquals(reg.getAvailable("line_edit"), []);
});

Deno.test("ModelRegistry - initialize marks correct models as available", async () => {
  const reg = await makeRegistry();
  reg.initialize(ZEN_MODELS);

  const available = reg.getAvailable("line_edit");
  const tags = available.map((e) => e.tag);
  assertEquals(tags.includes("gemini-3.5-flash"), true);
  assertEquals(tags.includes("gemini-3.1-pro"), true);
  assertEquals(tags.includes("claude-opus-4-8"), true);
  assertEquals(tags.includes("deepseek-v4-pro"), true);
  assertEquals(tags.includes("glm-5.2"), true);
  assertEquals(tags.includes("kimi-k2.6"), true);
  assertEquals(tags.includes("minimax-m2.7"), true);
  assertEquals(tags.includes("gpt-5.5-pro"), true);
});

Deno.test("ModelRegistry - carries price from config registry", async () => {
  const reg = await makeRegistry();
  reg.initialize(ZEN_MODELS);

  const entries = reg.getAvailable("line_edit");
  const opus = entries.find((e) => e.tag === "claude-opus-4-8");
  assertExists(opus?.price);
  assertEquals(opus.price.input, 5.0);
  assertEquals(opus.price.output, 25.0);
  assertEquals(opus.price.cache_read, 0.5);
  assertEquals(opus.price.cache_write, 6.25);

  const deepseek = entries.find((e) => e.tag === "deepseek-v4-flash");
  assertExists(deepseek?.price);
  assertEquals(deepseek.price.input, 0.14);
  assertEquals(deepseek.price.cache_write, undefined);
});

Deno.test("loadConfig - default config carries pricing provenance", async () => {
  const config = await loadConfig({});
  assertExists(config.models.pricing);
  assertEquals(config.models.pricing.updated, "2026-07-06");
  assertEquals(
    config.models.pricing.source,
    "https://opencode.ai/docs/zen/#pricing",
  );
});

Deno.test("ModelRegistry - unavailable models not in getAvailable", async () => {
  const reg = await makeRegistry();
  reg.initialize([]);

  const available = reg.getAvailable("line_edit");
  assertEquals(available.length, 0);
});

// --- resolve ---

Deno.test("ModelRegistry - resolve returns config default when available", async () => {
  const reg = await makeRegistry();
  reg.initialize(ZEN_MODELS);

  const entry = reg.resolve("line_edit");
  assertExists(entry);
  assertEquals(entry.tag, "deepseek-v4-flash");
});

Deno.test("ModelRegistry - resolve returns first available when default not installed", async () => {
  const reg = await makeRegistry();
  // deepseek-v4-flash (the line_edit default) is not in this list.
  reg.initialize(["claude-sonnet-4-6", "gpt-5.5"]);

  const entry = reg.resolve("line_edit");
  assertExists(entry);
  assertEquals(entry.tag, "claude-sonnet-4-6");
});

Deno.test("ModelRegistry - resolve returns null when nothing available", async () => {
  const reg = await makeRegistry();
  reg.initialize([]);

  assertEquals(reg.resolve("line_edit"), null);
});

// --- setActive ---

Deno.test("ModelRegistry - setActive overrides resolve", async () => {
  const reg = await makeRegistry();
  reg.initialize(ZEN_MODELS);

  const ok = reg.setActive("line_edit", "qwen3.6-plus");
  assertEquals(ok, true);

  const entry = reg.resolve("line_edit");
  assertExists(entry);
  assertEquals(entry.tag, "qwen3.6-plus");
});

Deno.test("ModelRegistry - setActive returns false for unavailable tag", async () => {
  const reg = await makeRegistry();
  reg.initialize([]);

  const ok = reg.setActive("line_edit", "nonexistent-model");
  assertEquals(ok, false);
});

Deno.test("ModelRegistry - setActive returns false for wrong role", async () => {
  const reg = await makeRegistry();
  reg.initialize(ZEN_MODELS);

  const ok = reg.setActive("line_edit", "nonexistent-model");
  assertEquals(ok, false);
});

// --- getUnavailable ---

Deno.test("ModelRegistry - getUnavailable returns all uninstalled models", async () => {
  const reg = await makeRegistry();
  reg.initialize([]);

  const unavailable = reg.getUnavailable().map((e) => e.tag);
  assertEquals(unavailable.includes("gemini-3.5-flash"), true);
  assertEquals(unavailable.includes("claude-opus-4-8"), true);
  assertEquals(unavailable.includes("deepseek-v4-pro"), true);
  assertEquals(unavailable.includes("glm-5.2"), true);
  assertEquals(unavailable.includes("kimi-k2.6"), true);
  assertEquals(unavailable.includes("qwen3.6-plus"), true);
  assertEquals(unavailable.includes("minimax-m2.7"), true);
  assertEquals(unavailable.includes("gpt-5.5-pro"), true);
});

Deno.test("ModelRegistry - getUnavailable is empty when all models present", async () => {
  const reg = await makeRegistry();
  reg.initialize(ZEN_MODELS);

  assertEquals(reg.getUnavailable(), []);
});
