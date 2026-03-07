import { assertEquals, assertAlmostEquals } from "@std/assert";
import { openDatabase } from "../../src/store/db.ts";
import { createVectorStore } from "../../src/store/vectors.ts";

function makeDb() {
  const db = openDatabase(":memory:");
  db.migrate();
  return db;
}

function vec(values: number[]): Float32Array {
  return new Float32Array(values);
}

Deno.test("VectorStore - upsert and search returns nearest vector", () => {
  const db = makeDb();
  const vs = createVectorStore(db);

  // Three 2D vectors. Query is closest to v2.
  const v1 = vec([1, 0]);
  const v2 = vec([0, 1]);
  const v3 = vec([-1, 0]);
  const query = vec([0.1, 0.9]); // almost (0,1)

  vs.upsert("c1", v1);
  vs.upsert("c2", v2);
  vs.upsert("c3", v3);

  const results = vs.search(query, 3);
  assertEquals(results[0].id, "c2"); // closest
  assertEquals(results[2].id, "c3"); // farthest

  db.close();
});

Deno.test("VectorStore - search respects topK limit", () => {
  const db = makeDb();
  const vs = createVectorStore(db);

  for (let i = 0; i < 5; i++) {
    vs.upsert(`c${i}`, vec([i, 0]));
  }

  const results = vs.search(vec([1, 0]), 2);
  assertEquals(results.length, 2);

  db.close();
});

Deno.test("VectorStore - upsert replaces existing vector", () => {
  const db = makeDb();
  const vs = createVectorStore(db);

  vs.upsert("c1", vec([1, 0]));
  vs.upsert("c1", vec([0, 1])); // replace

  const results = vs.search(vec([0, 1]), 1);
  assertEquals(results[0].id, "c1");
  assertAlmostEquals(results[0].distance, 0, 1e-6);

  db.close();
});

Deno.test("VectorStore - deleteMany removes vectors", () => {
  const db = makeDb();
  const vs = createVectorStore(db);

  vs.upsert("c1", vec([1, 0]));
  vs.upsert("c2", vec([0, 1]));
  vs.upsert("c3", vec([-1, 0]));

  vs.deleteMany(["c1", "c2"]);

  const results = vs.search(vec([1, 0]), 10);
  assertEquals(results.length, 1);
  assertEquals(results[0].id, "c3");

  db.close();
});

Deno.test("VectorStore - deleteMany with empty array is a no-op", () => {
  const db = makeDb();
  const vs = createVectorStore(db);

  vs.upsert("c1", vec([1, 0]));
  vs.deleteMany([]);

  const results = vs.search(vec([1, 0]), 10);
  assertEquals(results.length, 1);

  db.close();
});

Deno.test("VectorStore - search on empty store returns empty array", () => {
  const db = makeDb();
  const vs = createVectorStore(db);

  const results = vs.search(vec([1, 0, 0]), 10);
  assertEquals(results.length, 0);

  db.close();
});

Deno.test("VectorStore - distance is 0 for identical vectors", () => {
  const db = makeDb();
  const vs = createVectorStore(db);

  const v = vec([0.5, 0.5, 0.5, 0.5]);
  vs.upsert("c1", v);

  const results = vs.search(v, 1);
  assertEquals(results.length, 1);
  assertAlmostEquals(results[0].distance, 0, 1e-6);

  db.close();
});

Deno.test("VectorStore - distance is ~2 for opposite vectors", () => {
  const db = makeDb();
  const vs = createVectorStore(db);

  vs.upsert("c1", vec([1, 0]));
  const results = vs.search(vec([-1, 0]), 1);

  // cosine similarity = -1, distance = 1 - (-1) = 2
  assertAlmostEquals(results[0].distance, 2, 1e-6);

  db.close();
});

Deno.test("VectorStore - handles 768-dimensional vectors (production size)", () => {
  const db = makeDb();
  const vs = createVectorStore(db);

  const dims = 768;
  const v1 = new Float32Array(dims).fill(0);
  v1[0] = 1;

  const v2 = new Float32Array(dims).fill(0);
  v2[1] = 1;

  vs.upsert("embed1", v1);
  vs.upsert("embed2", v2);

  const results = vs.search(v1, 2);
  assertEquals(results[0].id, "embed1");
  assertAlmostEquals(results[0].distance, 0, 1e-6);

  db.close();
});
