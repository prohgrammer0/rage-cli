import { assertEquals } from "@std/assert";
import { createScanner } from "../../src/ingest/scanner.ts";
import { openDatabase } from "../../src/store/db.ts";
import { createVectorStore } from "../../src/store/vectors.ts";
import { createQueries } from "../../src/store/queries.ts";

function makeStore() {
  const db = openDatabase(":memory:");
  db.migrate();
  const vectors = createVectorStore(db);
  const queries = createQueries(db, vectors);
  return { db, queries };
}

async function withTempVault(
  files: Record<string, string>,
  fn: (vaultPath: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    for (const [name, content] of Object.entries(files)) {
      // Support subdirectory paths.
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

// --- scan ---

Deno.test("Scanner - new files categorized as new", async () => {
  const { queries } = makeStore();
  const scanner = createScanner(queries);

  await withTempVault({ "note.md": "hello" }, async (vault) => {
    const result = await scanner.scan(vault, [".md"]);
    assertEquals(result.new.length, 1);
    assertEquals(result.modified.length, 0);
    assertEquals(result.unchanged.length, 0);
    assertEquals(result.deleted.length, 0);
  });
});

Deno.test("Scanner - unchanged files categorized correctly", async () => {
  const { queries } = makeStore();
  const scanner = createScanner(queries);

  await withTempVault({ "note.md": "hello" }, async (vault) => {
    const path = `${vault}/note.md`;
    const stat = await Deno.stat(path);
    queries.setFileState(path, stat.mtime!.getTime(), 1);

    const result = await scanner.scan(vault, [".md"]);
    assertEquals(result.unchanged.length, 1);
    assertEquals(result.new.length, 0);
  });
});

Deno.test("Scanner - modified files detected by mtime change", async () => {
  const { queries } = makeStore();
  const scanner = createScanner(queries);

  await withTempVault({ "note.md": "hello" }, async (vault) => {
    const path = `${vault}/note.md`;
    queries.setFileState(path, 1, 1); // wrong mtime

    const result = await scanner.scan(vault, [".md"]);
    assertEquals(result.modified.length, 1);
    assertEquals(result.unchanged.length, 0);
  });
});

Deno.test("Scanner - deleted files detected", async () => {
  const { queries } = makeStore();
  const scanner = createScanner(queries);

  await withTempVault({}, async (vault) => {
    queries.setFileState("/phantom/path.md", 1000, 2);

    const result = await scanner.scan(vault, [".md"]);
    assertEquals(result.deleted.includes("/phantom/path.md"), true);
  });
});

Deno.test("Scanner - filters by extension", async () => {
  const { queries } = makeStore();
  const scanner = createScanner(queries);

  await withTempVault({ "note.md": "md", "doc.txt": "txt" }, async (vault) => {
    const result = await scanner.scan(vault, [".md"]);
    assertEquals(result.new.length, 1);
    assertEquals(result.new[0].path.endsWith(".md"), true);
  });
});

Deno.test("Scanner - skips hidden directories", async () => {
  const { queries } = makeStore();
  const scanner = createScanner(queries);

  await withTempVault({
    "note.md": "visible",
    ".obsidian/config.md": "hidden",
  }, async (vault) => {
    const result = await scanner.scan(vault, [".md"]);
    assertEquals(result.new.length, 1);
    assertEquals(result.new[0].path.includes(".obsidian"), false);
  });
});

Deno.test("Scanner - recurses into subdirectories", async () => {
  const { queries } = makeStore();
  const scanner = createScanner(queries);

  await withTempVault({
    "a.md": "root",
    "sub/b.md": "sub",
    "sub/deep/c.md": "deep",
  }, async (vault) => {
    const result = await scanner.scan(vault, [".md"]);
    assertEquals(result.new.length, 3);
  });
});

// --- stalenessCount ---

Deno.test("Scanner - stalenessCount is 0 for empty vault and db", async () => {
  const { queries } = makeStore();
  const scanner = createScanner(queries);

  await withTempVault({}, async (vault) => {
    const count = await scanner.stalenessCount(vault, [".md"]);
    assertEquals(count, 0);
  });
});

Deno.test("Scanner - stalenessCount counts new files", async () => {
  const { queries } = makeStore();
  const scanner = createScanner(queries);

  await withTempVault({ "a.md": "x", "b.md": "y" }, async (vault) => {
    const count = await scanner.stalenessCount(vault, [".md"]);
    assertEquals(count, 2);
  });
});

Deno.test("Scanner - stalenessCount is 0 for up-to-date indexed vault", async () => {
  const { queries } = makeStore();
  const scanner = createScanner(queries);

  await withTempVault({ "a.md": "x" }, async (vault) => {
    const path = `${vault}/a.md`;
    const stat = await Deno.stat(path);
    queries.setFileState(path, stat.mtime!.getTime(), 1);

    const count = await scanner.stalenessCount(vault, [".md"]);
    assertEquals(count, 0);
  });
});
