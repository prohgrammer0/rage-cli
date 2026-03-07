import { assertEquals, assertExists } from "@std/assert";
import { createModelRegistry } from "../../src/config/models.ts";
import { loadConfig } from "../../src/config/loader.ts";

async function makeRegistry() {
  const config = await loadConfig({});
  return createModelRegistry(config);
}

const LOCAL_MODELS = [
  "nomic-embed-text:latest",
];
const ZEN_MODELS = [
  "minimax-m2.5",
  "kimi-k2.5",
  "glm-5",
];

// --- initialization ---

Deno.test("ModelRegistry - getAvailable returns empty before initialize", async () => {
  const reg = await makeRegistry();
  assertEquals(reg.getAvailable("line_edit"), []);
});

Deno.test("ModelRegistry - initialize marks correct models as available", async () => {
  const reg = await makeRegistry();
  reg.initialize(LOCAL_MODELS, ZEN_MODELS);

  const available = reg.getAvailable("line_edit");
  const tags = available.map((e) => e.tag);
  assertEquals(tags.includes("minimax-m2.5"), true);
  assertEquals(tags.includes("kimi-k2.5"), true);
  assertEquals(tags.includes("glm-5"), true);
  // embedding-only model should not appear in line_edit
  assertEquals(tags.includes("nomic-embed-text:latest"), false);
});

Deno.test("ModelRegistry - unavailable models not in getAvailable", async () => {
  const reg = await makeRegistry();
  // Only local embedding model installed, no zen models.
  reg.initialize(LOCAL_MODELS, []);

  const available = reg.getAvailable("line_edit");
  assertEquals(available.length, 0);
});

// --- resolve ---

Deno.test("ModelRegistry - resolve returns config default when available", async () => {
  const reg = await makeRegistry();
  reg.initialize(LOCAL_MODELS, ZEN_MODELS);

  const entry = reg.resolve("line_edit");
  assertExists(entry);
  assertEquals(entry.tag, "minimax-m2.5");
});

Deno.test("ModelRegistry - resolve returns first available when default not installed", async () => {
  const reg = await makeRegistry();
  // minimax-m2.5 (the line_edit default) is not in this list.
  reg.initialize(LOCAL_MODELS, ["kimi-k2.5", "glm-5"]);

  const entry = reg.resolve("line_edit");
  assertExists(entry);
  assertEquals(entry.tag, "kimi-k2.5");
});

Deno.test("ModelRegistry - resolve returns null when nothing available", async () => {
  const reg = await makeRegistry();
  reg.initialize([], []);

  assertEquals(reg.resolve("line_edit"), null);
});

Deno.test("ModelRegistry - resolve returns embedding model", async () => {
  const reg = await makeRegistry();
  reg.initialize(LOCAL_MODELS, ZEN_MODELS);

  const entry = reg.resolve("embedding");
  assertExists(entry);
  assertEquals(entry.tag, "nomic-embed-text:latest");
});

// --- setActive ---

Deno.test("ModelRegistry - setActive overrides resolve", async () => {
  const reg = await makeRegistry();
  reg.initialize(LOCAL_MODELS, ZEN_MODELS);

  const ok = reg.setActive("line_edit", "kimi-k2.5");
  assertEquals(ok, true);

  const entry = reg.resolve("line_edit");
  assertExists(entry);
  assertEquals(entry.tag, "kimi-k2.5");
});

Deno.test("ModelRegistry - setActive returns false for unavailable tag", async () => {
  const reg = await makeRegistry();
  reg.initialize([], []);

  const ok = reg.setActive("line_edit", "nonexistent-model");
  assertEquals(ok, false);
});

Deno.test("ModelRegistry - setActive returns false for wrong role", async () => {
  const reg = await makeRegistry();
  reg.initialize(LOCAL_MODELS, ZEN_MODELS);

  // nomic-embed-text is embedding only, not line_edit.
  const ok = reg.setActive("line_edit", "nomic-embed-text:latest");
  assertEquals(ok, false);
});

// --- getUnavailable ---

Deno.test("ModelRegistry - getUnavailable returns all uninstalled models", async () => {
  const reg = await makeRegistry();
  // Only embedding model installed, no zen models.
  reg.initialize(["nomic-embed-text:latest"], []);

  const unavailable = reg.getUnavailable().map((e) => e.tag);
  assertEquals(unavailable.includes("minimax-m2.5"), true);
  assertEquals(unavailable.includes("kimi-k2.5"), true);
  assertEquals(unavailable.includes("glm-5"), true);
  assertEquals(unavailable.includes("nomic-embed-text:latest"), false);
});

Deno.test("ModelRegistry - getUnavailable is empty when all models present", async () => {
  const reg = await makeRegistry();
  reg.initialize(LOCAL_MODELS, ZEN_MODELS);

  assertEquals(reg.getUnavailable(), []);
});
