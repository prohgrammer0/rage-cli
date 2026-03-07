import { assertEquals, assertStringIncludes } from "@std/assert";
import { createRenderer } from "../../src/chat/renderer.ts";
import type { ModelEntry } from "../../src/config/models.ts";

// Use color=false so we can assert on plain strings.
function makeRenderer() {
  return createRenderer({ useColor: false });
}

// --- renderPrompt ---

Deno.test("Renderer - renderPrompt includes role and model", () => {
  const r = makeRenderer();
  const prompt = r.renderPrompt("line", "gemma3:12b");
  assertStringIncludes(prompt, "line");
  assertStringIncludes(prompt, "gemma3:12b");
  assertStringIncludes(prompt, ">");
});

Deno.test("Renderer - renderPrompt truncates model path to last segment", () => {
  const r = makeRenderer();
  const prompt = r.renderPrompt("dev", "opencode/claude-sonnet-4-20250514");
  assertStringIncludes(prompt, "claude-sonnet-4-20250514");
});

Deno.test("Renderer - renderPrompt uses dev for developmental role", () => {
  const r = makeRenderer();
  const prompt = r.renderPrompt("dev", "model");
  assertStringIncludes(prompt, "dev");
});

// --- renderModelList ---

Deno.test("Renderer - renderModelList with empty list prints no models message", () => {
  const r = makeRenderer();
  // Just verify it doesn't throw.
  r.renderModelList([]);
});

Deno.test("Renderer - renderModelList renders model tags", () => {
  const r = makeRenderer();
  const models: ModelEntry[] = [
    {
      tag: "gemma3:12b",
      provider: "ollama",
      roles: ["line_edit"],
      available: true,
      notes: "Default local.",
    },
  ];
  // We can't easily capture stdout in Deno tests; just verify no throw.
  r.renderModelList(models);
});

// --- renderStatus ---

Deno.test("Renderer - renderStatus does not throw", () => {
  const r = makeRenderer();
  r.renderStatus({
    role: "line",
    model: "gemma3:12b",
    vaultPath: "/vault",
    chunkCount: 42,
    staleFileCount: 3,
    dbPath: "./data/rage.db",
  });
});

// --- renderIngestStats ---

Deno.test("Renderer - renderIngestStats does not throw", () => {
  const r = makeRenderer();
  r.renderIngestStats({
    filesScanned: 10,
    filesSkipped: 5,
    filesProcessed: 5,
    filesPruned: 1,
    chunksCreated: 20,
    chunksReused: 3,
    chunksPruned: 7,
  });
});

// --- log levels ---

Deno.test("Renderer - log does not throw for all levels", () => {
  const r = makeRenderer();
  r.log("debug", "debug message");
  r.log("info", "info message");
  r.log("warn", "warn message");
  r.log("error", "error message");
});
