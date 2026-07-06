import { assertEquals, assertStringIncludes } from "@std/assert";
import { createRenderer, responseUsageStats } from "../../src/chat/renderer.ts";
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
  assertStringIncludes(prompt, "❯");
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
      tag: "gemini-3.5-flash",
      provider: "zen",
      roles: ["line_edit"],
      available: true,
      notes: "Fast line editor.",
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
    model: "gemini-3.5-flash",
    sourceLabel: "/notes/a.md, /notes/b.md",
    fileCount: 42,
    contextTokens: 12345,
  });
});

Deno.test("Renderer - renderSessionList does not throw", () => {
  const r = makeRenderer();
  r.renderSessionList([
    {
      id: 7,
      project: "book",
      sourceLabel: "book: /notes/book",
      editorRole: "dev",
      model: "claude-opus-4-8",
      contextHash: "abc",
      createdAt: "2026-06-30T12:00:00.000Z",
      updatedAt: "2026-06-30T12:05:00.000Z",
      messageCount: 2,
      preview: "Review the opening chapter.",
    },
  ]);
});

Deno.test("Renderer - renderTranscript does not throw", () => {
  const r = makeRenderer();
  r.renderTranscript([
    { role: "user", content: "Review the opening." },
    { role: "assistant", content: "The opening lacks a clear focal point." },
  ]);
});

// --- renderResponseFooter ---

Deno.test("Renderer - renderResponseFooter does not throw", () => {
  const r = makeRenderer();
  r.renderResponseFooter({
    elapsedMs: 3214,
    approxTokens: 1421,
    model: "zen/claude-sonnet-5",
  });
  r.renderResponseFooter({
    elapsedMs: 3214,
    approxTokens: 1421,
    inputTokens: 18200,
    outputTokens: 1400,
    costUsd: 0.0214,
    model: "zen/claude-sonnet-5",
  });
});

// --- responseUsageStats ---

Deno.test("responseUsageStats - returns empty without usage", () => {
  assertEquals(responseUsageStats(null, { input: 3, output: 15 }), {});
});

Deno.test("responseUsageStats - sums prompt buckets, omits cost without price", () => {
  const stats = responseUsageStats(
    {
      inputTokens: 200,
      outputTokens: 300,
      cacheReadTokens: 1000,
      cacheWriteTokens: 100,
    },
    undefined,
  );
  assertEquals(stats, { inputTokens: 1300, outputTokens: 300 });
});

Deno.test("responseUsageStats - prices each bucket with cache rates", () => {
  const stats = responseUsageStats(
    {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
    },
    { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
  );
  assertEquals(stats.costUsd, 3 + 15 + 0.3 + 3.75);
});

Deno.test("responseUsageStats - cache rates default to input rate", () => {
  const stats = responseUsageStats(
    {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 2_000_000,
      cacheWriteTokens: 0,
    },
    { input: 3, output: 15 },
  );
  assertEquals(stats.costUsd, 6);
});

// --- renderTurnDivider ---

Deno.test("Renderer - renderTurnDivider does not throw", () => {
  const r = makeRenderer();
  r.renderTurnDivider();
});

// --- log levels ---

Deno.test("Renderer - log does not throw for all levels", () => {
  const r = makeRenderer();
  r.log("debug", "debug message");
  r.log("info", "info message");
  r.log("warn", "warn message");
  r.log("error", "error message");
});
