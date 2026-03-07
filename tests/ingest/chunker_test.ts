import { assertEquals, assertExists } from "@std/assert";
import { chunkMarkdown, estimateTokens } from "../../src/ingest/chunker.ts";

const CONFIG = { chunkSize: 50, chunkOverlap: 10 };

// --- estimateTokens ---

Deno.test("estimateTokens - empty string is 0", () => {
  assertEquals(estimateTokens(""), 0);
});

Deno.test("estimateTokens - 4 chars = 1 token", () => {
  assertEquals(estimateTokens("abcd"), 1);
});

Deno.test("estimateTokens - rounds up", () => {
  assertEquals(estimateTokens("abc"), 1); // ceil(3/4) = 1
  assertEquals(estimateTokens("aaaaa"), 2); // ceil(5/4) = 2
});

// --- basic chunking ---

Deno.test("chunkMarkdown - single paragraph produces one chunk", async () => {
  const content = "This is a single paragraph.";
  const chunks = await chunkMarkdown("test.md", content, CONFIG);
  assertEquals(chunks.length, 1);
  assertEquals(chunks[0].content, content);
  assertEquals(chunks[0].filePath, "test.md");
  assertEquals(chunks[0].lineStart, 0);
});

Deno.test("chunkMarkdown - empty file produces no chunks", async () => {
  const chunks = await chunkMarkdown("test.md", "", CONFIG);
  assertEquals(chunks.length, 0);
});

Deno.test("chunkMarkdown - whitespace-only file produces no chunks", async () => {
  const chunks = await chunkMarkdown("test.md", "\n\n\n", CONFIG);
  assertEquals(chunks.length, 0);
});

// --- frontmatter ---

Deno.test("chunkMarkdown - strips frontmatter from content", async () => {
  const content = `---
title: My Essay
tags: [writing]
---

This is the body.`;
  const chunks = await chunkMarkdown("test.md", content, CONFIG);
  assertEquals(chunks.length, 1);
  assertEquals(chunks[0].content, "This is the body.");
  assertExists(chunks[0].frontmatter);
  assertEquals((chunks[0].frontmatter as Record<string, unknown>)["title"], "My Essay");
});

Deno.test("chunkMarkdown - frontmatter propagates to all chunks", async () => {
  // Make content large enough to produce multiple chunks.
  const para = "x".repeat(250); // 250 chars ≈ 62 tokens > chunkSize=50
  const content = `---
title: Test
---

${para}

${para}`;
  const chunks = await chunkMarkdown("test.md", content, CONFIG);
  for (const chunk of chunks) {
    assertEquals(
      (chunk.frontmatter as Record<string, unknown>)?.["title"],
      "Test",
    );
  }
});

// --- multi-paragraph chunking ---

Deno.test("chunkMarkdown - two short paragraphs merge into one chunk", async () => {
  const content = "Short para one.\n\nShort para two.";
  const chunks = await chunkMarkdown("test.md", content, { chunkSize: 100, chunkOverlap: 10 });
  assertEquals(chunks.length, 1);
});

Deno.test("chunkMarkdown - large content splits into multiple chunks", async () => {
  // Each paragraph is ~80 tokens, chunkSize=50 forces splits.
  const para = "word ".repeat(80); // 400 chars ≈ 100 tokens
  const content = `${para}\n\n${para}\n\n${para}`;
  const chunks = await chunkMarkdown("test.md", content, CONFIG);
  assertEquals(chunks.length >= 3, true);
});

Deno.test("chunkMarkdown - each chunk has unique id", async () => {
  const para = "word ".repeat(80);
  const content = `${para}\n\n${para}\n\n${para}`;
  const chunks = await chunkMarkdown("test.md", content, CONFIG);
  const ids = new Set(chunks.map((c) => c.id));
  assertEquals(ids.size, chunks.length);
});

Deno.test("chunkMarkdown - chunk ids are deterministic", async () => {
  const content = "Hello world.";
  const a = await chunkMarkdown("test.md", content, CONFIG);
  const b = await chunkMarkdown("test.md", content, CONFIG);
  assertEquals(a[0].id, b[0].id);
  assertEquals(a[0].contentHash, b[0].contentHash);
});

// --- code blocks ---

Deno.test("chunkMarkdown - fenced code block is kept whole", async () => {
  const code = "```typescript\nconst x = 1;\nconst y = 2;\n```";
  const chunks = await chunkMarkdown("test.md", code, CONFIG);
  assertEquals(chunks.length, 1);
  assertEquals(chunks[0].content, code);
});

Deno.test("chunkMarkdown - oversized code block is its own chunk", async () => {
  // Code block alone exceeds chunkSize; should still be a single chunk.
  const code = "```\n" + "line\n".repeat(100) + "```";
  const chunks = await chunkMarkdown("test.md", code, CONFIG);
  assertEquals(chunks.length, 1);
});

// --- link extraction ---

Deno.test("chunkMarkdown - extracts markdown links", async () => {
  const content = "See [this article](https://example.com/article) for details.";
  const chunks = await chunkMarkdown("test.md", content, CONFIG);
  assertEquals(chunks[0].links.includes("https://example.com/article"), true);
});

Deno.test("chunkMarkdown - extracts bare URLs", async () => {
  const content = "Visit https://example.com for more.";
  const chunks = await chunkMarkdown("test.md", content, CONFIG);
  assertEquals(chunks[0].links.includes("https://example.com"), true);
});

Deno.test("chunkMarkdown - no duplicate links", async () => {
  const content =
    "[link](https://example.com) and also https://example.com mentioned again.";
  const chunks = await chunkMarkdown("test.md", content, CONFIG);
  const count = chunks[0].links.filter((l) => l === "https://example.com")
    .length;
  assertEquals(count, 1);
});

Deno.test("chunkMarkdown - empty links array for plain text", async () => {
  const chunks = await chunkMarkdown("test.md", "Just plain text.", CONFIG);
  assertEquals(chunks[0].links, []);
});

// --- line numbers ---

Deno.test("chunkMarkdown - line numbers are correct for body without frontmatter", async () => {
  const content = "Line one.\nLine two.\n\nLine four.";
  const chunks = await chunkMarkdown("test.md", content, {
    chunkSize: 100,
    chunkOverlap: 10,
  });
  // All in one chunk, lineStart should be 0 (first body line = line 0 with 0 fm lines).
  assertEquals(chunks[0].lineStart, 0);
});

Deno.test("chunkMarkdown - content hash differs for different content", async () => {
  const a = await chunkMarkdown("test.md", "Content A.", CONFIG);
  const b = await chunkMarkdown("test.md", "Content B.", CONFIG);
  assertEquals(a[0].contentHash !== b[0].contentHash, true);
});
