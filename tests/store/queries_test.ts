import { assertEquals, assertExists } from "@std/assert";
import { openDatabase } from "../../src/store/db.ts";
import { createVectorStore } from "../../src/store/vectors.ts";
import { createQueries } from "../../src/store/queries.ts";
import type { ChunkRow } from "../../src/store/queries.ts";

function makeStore() {
  const db = openDatabase(":memory:");
  db.migrate();
  const vectors = createVectorStore(db);
  const queries = createQueries(db, vectors);
  return { db, vectors, queries };
}

function makeChunk(overrides: Partial<ChunkRow> = {}): Omit<
  ChunkRow,
  "created_at" | "updated_at"
> {
  return {
    id: "chunk1",
    file_path: "notes/essay.md",
    line_start: 1,
    line_end: 10,
    content: "This is a test paragraph.",
    frontmatter: null,
    links: null,
    content_hash: "abc123",
    ...overrides,
  };
}

// --- upsertChunk ---

Deno.test("Queries - upsertChunk inserts a new chunk", () => {
  const { queries, db } = makeStore();
  queries.upsertChunk(makeChunk());

  const row = queries.getChunk("chunk1");
  assertExists(row);
  assertEquals(row.content, "This is a test paragraph.");
  assertEquals(row.file_path, "notes/essay.md");

  db.close();
});

Deno.test("Queries - upsertChunk updates existing chunk on conflict", () => {
  const { queries, db } = makeStore();
  queries.upsertChunk(makeChunk({ content: "original" }));
  queries.upsertChunk(makeChunk({ content: "updated" }));

  const row = queries.getChunk("chunk1");
  assertEquals(row?.content, "updated");

  db.close();
});

Deno.test("Queries - upsertChunk stores frontmatter and links as JSON strings", () => {
  const { queries, db } = makeStore();
  queries.upsertChunk(makeChunk({
    frontmatter: JSON.stringify({ title: "Essay", tags: ["writing"] }),
    links: JSON.stringify(["https://example.com"]),
  }));

  const row = queries.getChunk("chunk1");
  const fm = JSON.parse(row?.frontmatter ?? "null");
  assertEquals(fm?.title, "Essay");

  db.close();
});

// --- pruneFile ---

Deno.test("Queries - pruneFile removes all chunks for a file", () => {
  const { queries, vectors, db } = makeStore();
  queries.upsertChunk(makeChunk({ id: "c1" }));
  queries.upsertChunk(makeChunk({ id: "c2", line_start: 11, line_end: 20 }));
  vectors.upsert("c1", new Float32Array([1, 0]));
  vectors.upsert("c2", new Float32Array([0, 1]));

  const pruned = queries.pruneFile("notes/essay.md");
  assertEquals(pruned.sort(), ["c1", "c2"]);
  assertEquals(queries.getChunk("c1"), null);
  assertEquals(queries.getChunk("c2"), null);

  // Vectors should also be removed.
  const vecResults = vectors.search(new Float32Array([1, 0]), 10);
  assertEquals(vecResults.length, 0);

  db.close();
});

Deno.test("Queries - pruneFile returns empty array if file not indexed", () => {
  const { queries, db } = makeStore();
  const pruned = queries.pruneFile("nonexistent.md");
  assertEquals(pruned, []);
  db.close();
});

// --- getChunk ---

Deno.test("Queries - getChunk returns null for unknown id", () => {
  const { queries, db } = makeStore();
  assertEquals(queries.getChunk("nope"), null);
  db.close();
});

// --- getChunkIdsByFile ---

Deno.test("Queries - getChunkIdsByFile returns correct ids", () => {
  const { queries, db } = makeStore();
  queries.upsertChunk(makeChunk({ id: "c1" }));
  queries.upsertChunk(makeChunk({ id: "c2", line_start: 11, line_end: 20 }));
  queries.upsertChunk(
    makeChunk({ id: "c3", file_path: "other.md", line_start: 1, line_end: 5 }),
  );

  const ids = queries.getChunkIdsByFile("notes/essay.md").sort();
  assertEquals(ids, ["c1", "c2"]);

  db.close();
});

// --- search ---

Deno.test("Queries - search returns chunk rows with distances", () => {
  const { queries, vectors, db } = makeStore();

  queries.upsertChunk(makeChunk({ id: "c1", content: "content a" }));
  queries.upsertChunk(
    makeChunk({ id: "c2", content: "content b", line_start: 11, line_end: 20 }),
  );

  vectors.upsert("c1", new Float32Array([1, 0]));
  vectors.upsert("c2", new Float32Array([0, 1]));

  const results = queries.search(new Float32Array([1, 0]), 2);
  assertEquals(results.length, 2);
  assertEquals(results[0].id, "c1");
  assertEquals(typeof results[0].distance, "number");
  assertEquals(results[0].content, "content a");

  db.close();
});

// --- getFileState / setFileState ---

Deno.test("Queries - getFileState returns null for unknown file", () => {
  const { queries, db } = makeStore();
  assertEquals(queries.getFileState("unknown.md"), null);
  db.close();
});

Deno.test("Queries - setFileState and getFileState round-trip", () => {
  const { queries, db } = makeStore();
  queries.setFileState("notes/a.md", 1700000000000, 5);

  const state = queries.getFileState("notes/a.md");
  assertExists(state);
  assertEquals(state.path, "notes/a.md");
  assertEquals(state.mtime_ms, 1700000000000);
  assertEquals(state.chunk_count, 5);

  db.close();
});

Deno.test("Queries - setFileState updates existing entry", () => {
  const { queries, db } = makeStore();
  queries.setFileState("notes/a.md", 1000, 3);
  queries.setFileState("notes/a.md", 2000, 7);

  const state = queries.getFileState("notes/a.md");
  assertEquals(state?.mtime_ms, 2000);
  assertEquals(state?.chunk_count, 7);

  db.close();
});

// --- hasChunks ---

Deno.test("Queries - hasChunks returns false on empty database", () => {
  const { queries, db } = makeStore();
  assertEquals(queries.hasChunks(), false);
  db.close();
});

Deno.test("Queries - hasChunks returns true after inserting a chunk", () => {
  const { queries, db } = makeStore();
  queries.upsertChunk(makeChunk());
  assertEquals(queries.hasChunks(), true);
  db.close();
});

// --- countStaleFiles ---

Deno.test("Queries - countStaleFiles: zero stale for empty vault and empty db", () => {
  const { queries, db } = makeStore();
  assertEquals(queries.countStaleFiles([]), 0);
  db.close();
});

Deno.test("Queries - countStaleFiles: new file counted as stale", () => {
  const { queries, db } = makeStore();
  const count = queries.countStaleFiles([
    { path: "new.md", mtimeMs: 1000 },
  ]);
  assertEquals(count, 1);
  db.close();
});

Deno.test("Queries - countStaleFiles: unchanged file not counted", () => {
  const { queries, db } = makeStore();
  queries.setFileState("a.md", 1000, 2);

  const count = queries.countStaleFiles([{ path: "a.md", mtimeMs: 1000 }]);
  assertEquals(count, 0);
  db.close();
});

Deno.test("Queries - countStaleFiles: modified file counted as stale", () => {
  const { queries, db } = makeStore();
  queries.setFileState("a.md", 1000, 2);

  const count = queries.countStaleFiles([{ path: "a.md", mtimeMs: 9999 }]);
  assertEquals(count, 1);
  db.close();
});

Deno.test("Queries - countStaleFiles: deleted file counted as stale", () => {
  const { queries, db } = makeStore();
  queries.setFileState("deleted.md", 1000, 2);

  // Vault has no files — deleted.md is in DB but not on disk.
  const count = queries.countStaleFiles([]);
  assertEquals(count, 1);
  db.close();
});

Deno.test("Queries - countStaleFiles: combined new + modified + deleted", () => {
  const { queries, db } = makeStore();
  queries.setFileState("unchanged.md", 1000, 1);
  queries.setFileState("modified.md", 1000, 2);
  queries.setFileState("deleted.md", 1000, 3);

  const count = queries.countStaleFiles([
    { path: "unchanged.md", mtimeMs: 1000 }, // unchanged
    { path: "modified.md", mtimeMs: 9999 }, // modified
    { path: "new.md", mtimeMs: 500 }, // new
    // deleted.md is absent → deleted
  ]);
  assertEquals(count, 3); // modified + new + deleted
  db.close();
});
