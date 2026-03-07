import { assertEquals, assertStringIncludes } from "@std/assert";
import { assembleContext } from "../../src/retrieval/context.ts";
import type { SearchResult } from "../../src/store/queries.ts";

function makeResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    id: "c1",
    file_path: "essay.md",
    line_start: 1,
    line_end: 10,
    content: "Some content here.",
    frontmatter: null,
    links: null,
    content_hash: "hash",
    created_at: "",
    updated_at: "",
    distance: 0.1,
    ...overrides,
  };
}

// --- basic formatting ---

Deno.test("assembleContext - formats chunk with header", () => {
  const result = makeResult({ file_path: "essay.md", line_start: 5, line_end: 15 });
  const ctx = assembleContext([result], 10000);
  assertStringIncludes(ctx, "--- [essay.md L:5-15] ---");
  assertStringIncludes(ctx, "Some content here.");
});

Deno.test("assembleContext - returns empty string for empty results", () => {
  assertEquals(assembleContext([], 10000), "");
});

Deno.test("assembleContext - includes multiple chunks separated by blank line", () => {
  const r1 = makeResult({ id: "c1", file_path: "a.md", line_start: 1, line_end: 5, distance: 0.1 });
  const r2 = makeResult({ id: "c2", file_path: "b.md", line_start: 1, line_end: 5, distance: 0.2 });
  const ctx = assembleContext([r1, r2], 10000);
  assertStringIncludes(ctx, "a.md");
  assertStringIncludes(ctx, "b.md");
});

// --- token budget ---

Deno.test("assembleContext - respects maxTokens budget", () => {
  // Each chunk has ~50 chars of content (≈13 tokens + header overhead).
  const chunks = Array.from({ length: 10 }, (_, i) =>
    makeResult({
      id: `c${i}`,
      file_path: `f${i}.md`,
      line_start: 1,
      line_end: 5,
      content: "x".repeat(200), // 200 chars ≈ 50 tokens
      distance: i * 0.1,
    })
  );

  // Budget of 100 tokens should fit only 1-2 chunks (each is ~60 tokens with header).
  const ctx = assembleContext(chunks, 100);
  const chunkCount = (ctx.match(/--- \[/g) ?? []).length;
  assertEquals(chunkCount <= 2, true);
});

Deno.test("assembleContext - always includes at least one chunk even if over budget", () => {
  // Single chunk that exceeds the budget should still be included.
  const chunk = makeResult({ content: "x".repeat(10000) }); // huge
  const ctx = assembleContext([chunk], 1);
  assertStringIncludes(ctx, "---");
});

// --- deduplication ---

Deno.test("assembleContext - deduplicates overlapping chunks from same file", () => {
  // c1 and c2 overlap (lines 1-15 and 10-25), both from essay.md.
  // c1 has lower distance → keep c1, drop c2.
  const c1 = makeResult({
    id: "c1",
    file_path: "essay.md",
    line_start: 1,
    line_end: 15,
    distance: 0.1,
  });
  const c2 = makeResult({
    id: "c2",
    file_path: "essay.md",
    line_start: 10,
    line_end: 25,
    distance: 0.2,
  });

  const ctx = assembleContext([c1, c2], 10000);
  const chunkCount = (ctx.match(/--- \[/g) ?? []).length;
  assertEquals(chunkCount, 1);
  assertStringIncludes(ctx, "L:1-15");
});

Deno.test("assembleContext - non-overlapping chunks from same file both included", () => {
  const c1 = makeResult({
    id: "c1",
    file_path: "essay.md",
    line_start: 1,
    line_end: 10,
    distance: 0.1,
  });
  const c2 = makeResult({
    id: "c2",
    file_path: "essay.md",
    line_start: 20,
    line_end: 30,
    distance: 0.2,
  });

  const ctx = assembleContext([c1, c2], 10000);
  const chunkCount = (ctx.match(/--- \[/g) ?? []).length;
  assertEquals(chunkCount, 2);
});

Deno.test("assembleContext - overlapping chunks from different files both kept", () => {
  // Same line ranges, different files — both should be included.
  const c1 = makeResult({
    id: "c1",
    file_path: "a.md",
    line_start: 1,
    line_end: 20,
    distance: 0.1,
  });
  const c2 = makeResult({
    id: "c2",
    file_path: "b.md",
    line_start: 1,
    line_end: 20,
    distance: 0.2,
  });

  const ctx = assembleContext([c1, c2], 10000);
  const chunkCount = (ctx.match(/--- \[/g) ?? []).length;
  assertEquals(chunkCount, 2);
});

Deno.test("assembleContext - chunks ranked by distance (best first)", () => {
  const close = makeResult({ id: "c1", file_path: "a.md", line_start: 1, line_end: 5, content: "CLOSE", distance: 0.05 });
  const far = makeResult({ id: "c2", file_path: "b.md", line_start: 1, line_end: 5, content: "FAR", distance: 0.9 });

  // Results arrive pre-sorted (ascending distance) from the search layer.
  const ctx = assembleContext([close, far], 10000);
  const closePos = ctx.indexOf("CLOSE");
  const farPos = ctx.indexOf("FAR");
  assertEquals(closePos < farPos, true);
});
