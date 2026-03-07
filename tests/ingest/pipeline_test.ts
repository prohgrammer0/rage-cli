import { assertEquals, assertExists } from "@std/assert";
import { createPipeline } from "../../src/ingest/pipeline.ts";
import { createScanner } from "../../src/ingest/scanner.ts";
import { createEmbedder } from "../../src/ingest/embedder.ts";
import { openDatabase } from "../../src/store/db.ts";
import { createVectorStore } from "../../src/store/vectors.ts";
import { createQueries } from "../../src/store/queries.ts";

const DIM = 4; // Use small dimension for test embedder.

/** Stub embedder that returns a deterministic vector from text length. */
function makeTestEmbedder() {
  return {
    embed(text: string): Promise<Float32Array> {
      const v = new Float32Array(DIM).fill(text.length % 10);
      return Promise.resolve(v);
    },
  };
}

function makeStore() {
  const db = openDatabase(":memory:");
  db.migrate();
  const vectors = createVectorStore(db);
  const queries = createQueries(db, vectors);
  const scanner = createScanner(queries);
  const embedder = makeTestEmbedder();
  const pipeline = createPipeline(scanner, embedder, queries, vectors);
  return { db, queries, vectors, pipeline };
}

async function withTempVault(
  files: Record<string, string>,
  fn: (vaultPath: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    for (const [name, content] of Object.entries(files)) {
      const fullPath = `${dir}/${name}`;
      const parentDir = fullPath.substring(0, fullPath.lastIndexOf("/"));
      await Deno.mkdir(parentDir, { recursive: true });
      await Deno.writeTextFile(fullPath, content);
    }
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const defaultOptions = (vaultPath: string) => ({
  vaultPath,
  extensions: [".md"],
  chunkSize: 512,
  chunkOverlap: 64,
  embeddingModel: "nomic-embed-text",
});

// --- basic run ---

Deno.test("Pipeline - processes new files and returns stats", async () => {
  const { pipeline } = makeStore();

  await withTempVault({ "note.md": "This is a test note." }, async (vault) => {
    const stats = await pipeline.run(defaultOptions(vault));
    assertEquals(stats.filesScanned, 1);
    assertEquals(stats.filesProcessed, 1);
    assertEquals(stats.filesSkipped, 0);
    assertEquals(stats.chunksCreated >= 1, true);
  });
});

Deno.test("Pipeline - stores chunks in database", async () => {
  const { pipeline, queries } = makeStore();

  await withTempVault({ "note.md": "Test content here." }, async (vault) => {
    await pipeline.run(defaultOptions(vault));
    assertEquals(queries.hasChunks(), true);
  });
});

Deno.test("Pipeline - updates file state after processing", async () => {
  const { pipeline, queries } = makeStore();

  await withTempVault({ "note.md": "Hello." }, async (vault) => {
    await pipeline.run(defaultOptions(vault));
    const path = `${vault}/note.md`;
    const state = queries.getFileState(path);
    assertExists(state);
    assertEquals(state.chunk_count >= 1, true);
  });
});

// --- unchanged files ---

Deno.test("Pipeline - skips unchanged files on second run", async () => {
  const { pipeline } = makeStore();

  await withTempVault({ "note.md": "Same content." }, async (vault) => {
    const first = await pipeline.run(defaultOptions(vault));
    const second = await pipeline.run(defaultOptions(vault));

    assertEquals(first.chunksCreated >= 1, true);
    assertEquals(second.filesSkipped, 1);
    assertEquals(second.chunksCreated, 0);
  });
});

// --- content hash reuse ---

Deno.test("Pipeline - modified files re-embed chunks (spec: delete then reprocess)", async () => {
  const { pipeline, queries } = makeStore();

  await withTempVault({ "note.md": "Same content." }, async (vault) => {
    const path = `${vault}/note.md`;
    await pipeline.run(defaultOptions(vault));
    const firstCreated = queries.getAllFilePaths().length; // verify indexed
    assertEquals(firstCreated, 1);

    // Fake a mtime change without changing content.
    queries.setFileState(path, 1, 1); // wrong mtime forces reprocessing

    const second = await pipeline.run(defaultOptions(vault));
    // Modified files: delete-then-reprocess, so chunks are re-created not reused.
    assertEquals(second.chunksCreated >= 1, true);
    assertEquals(second.chunksPruned >= 1, true); // old chunks were pruned first
  });
});

// --- deleted files ---

Deno.test("Pipeline - prunes deleted files on second run", async () => {
  const { pipeline, queries } = makeStore();

  await withTempVault({ "note.md": "Content." }, async (vault) => {
    await pipeline.run(defaultOptions(vault));
    assertEquals(queries.hasChunks(), true);

    // Delete the file.
    await Deno.remove(`${vault}/note.md`);

    const stats = await pipeline.run(defaultOptions(vault));
    assertEquals(stats.filesPruned, 1);
    assertEquals(stats.chunksPruned >= 1, true);
    assertEquals(queries.hasChunks(), false);
  });
});

// --- multiple files ---

Deno.test("Pipeline - processes multiple files", async () => {
  const { pipeline, queries } = makeStore();

  await withTempVault({
    "a.md": "File A content.",
    "b.md": "File B content.",
  }, async (vault) => {
    const stats = await pipeline.run(defaultOptions(vault));
    assertEquals(stats.filesProcessed, 2);
    assertEquals(queries.hasChunks(), true);
  });
});

// --- subdirectories ---

Deno.test("Pipeline - processes files in subdirectories", async () => {
  const { pipeline } = makeStore();

  await withTempVault({
    "root.md": "Root note.",
    "sub/child.md": "Sub note.",
  }, async (vault) => {
    const stats = await pipeline.run(defaultOptions(vault));
    assertEquals(stats.filesProcessed, 2);
  });
});
