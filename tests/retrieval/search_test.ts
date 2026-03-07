import { assertEquals } from "@std/assert";
import { createRetrievalSearch } from "../../src/retrieval/search.ts";
import { openDatabase } from "../../src/store/db.ts";
import { createVectorStore } from "../../src/store/vectors.ts";
import { createQueries } from "../../src/store/queries.ts";

function makeStore() {
  const db = openDatabase(":memory:");
  db.migrate();
  const vectors = createVectorStore(db);
  const queries = createQueries(db, vectors);
  return { db, queries, vectors };
}

function makeEmbedder(vectors: Record<string, Float32Array>) {
  return {
    embed(text: string): Promise<Float32Array> {
      const v = vectors[text] ?? new Float32Array([0, 0, 0]);
      return Promise.resolve(v);
    },
  };
}

Deno.test("RetrievalSearch - returns empty array for empty database", async () => {
  const { queries } = makeStore();
  const embedder = makeEmbedder({});
  const search = createRetrievalSearch(embedder, queries);

  const results = await search.query("What is the main argument?");
  assertEquals(results, []);
});

Deno.test("RetrievalSearch - returns relevant chunks ranked by distance", async () => {
  const { queries, vectors } = makeStore();

  const vA = new Float32Array([1, 0, 0]);
  const vB = new Float32Array([0, 1, 0]);
  const query = new Float32Array([1, 0, 0]); // matches vA

  queries.upsertChunk({
    id: "c1",
    file_path: "a.md",
    line_start: 1,
    line_end: 5,
    content: "Content A",
    frontmatter: null,
    links: null,
    content_hash: "hash1",
  });
  queries.upsertChunk({
    id: "c2",
    file_path: "b.md",
    line_start: 1,
    line_end: 5,
    content: "Content B",
    frontmatter: null,
    links: null,
    content_hash: "hash2",
  });
  vectors.upsert("c1", vA);
  vectors.upsert("c2", vB);

  const embedder = makeEmbedder({ "my query": query });
  const search = createRetrievalSearch(embedder, queries);

  const results = await search.query("my query", 2);
  assertEquals(results.length, 2);
  assertEquals(results[0].id, "c1"); // closest to query
});

Deno.test("RetrievalSearch - respects topK parameter", async () => {
  const { queries, vectors } = makeStore();

  for (let i = 0; i < 5; i++) {
    queries.upsertChunk({
      id: `c${i}`,
      file_path: `f${i}.md`,
      line_start: 1,
      line_end: 1,
      content: `Content ${i}`,
      frontmatter: null,
      links: null,
      content_hash: `h${i}`,
    });
    vectors.upsert(`c${i}`, new Float32Array([i, 0, 0]));
  }

  const embedder = makeEmbedder({ "query": new Float32Array([1, 0, 0]) });
  const search = createRetrievalSearch(embedder, queries);

  const results = await search.query("query", 3);
  assertEquals(results.length, 3);
});

Deno.test("RetrievalSearch - default topK is 10", async () => {
  const { queries, vectors } = makeStore();

  // Insert 15 chunks.
  for (let i = 0; i < 15; i++) {
    queries.upsertChunk({
      id: `c${i}`,
      file_path: `f${i}.md`,
      line_start: 1,
      line_end: 1,
      content: `Content ${i}`,
      frontmatter: null,
      links: null,
      content_hash: `h${i}`,
    });
    vectors.upsert(`c${i}`, new Float32Array([i % 5, 0]));
  }

  const embedder = makeEmbedder({ "query": new Float32Array([1, 0]) });
  const search = createRetrievalSearch(embedder, queries);

  const results = await search.query("query"); // no topK, uses default 10
  assertEquals(results.length, 10);
});
