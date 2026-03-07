import { assertEquals } from "@std/assert";
import { openDatabase } from "../../src/store/db.ts";

Deno.test("openDatabase - creates and migrates in-memory database", () => {
  const db = openDatabase(":memory:");
  db.migrate();

  // Schema should exist — verify by inserting a row.
  db.sqlite.prepare(
    "INSERT INTO chunks (id, file_path, line_start, line_end, content, content_hash) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("id1", "file.md", 1, 5, "hello", "hash1");

  const row = db.sqlite.prepare("SELECT id FROM chunks WHERE id = ?").get<
    { id: string }
  >("id1");
  assertEquals(row?.id, "id1");

  db.close();
});

Deno.test("openDatabase - migrate is idempotent", () => {
  const db = openDatabase(":memory:");
  db.migrate();
  db.migrate(); // second call should not throw
  db.close();
});

Deno.test("openDatabase - pragma user_version increments after migration", () => {
  const db = openDatabase(":memory:");

  const before = db.sqlite.prepare("PRAGMA user_version").get<
    { user_version: number }
  >();
  assertEquals(before?.user_version, 0);

  db.migrate();

  const after = db.sqlite.prepare("PRAGMA user_version").get<
    { user_version: number }
  >();
  assertEquals(after?.user_version, 1);

  db.close();
});

Deno.test("openDatabase - creates parent directory for file-based DB", async () => {
  const tmpDir = await Deno.makeTempDir();
  const dbPath = `${tmpDir}/subdir/test.db`;

  const db = openDatabase(dbPath);
  db.migrate();
  db.close();

  // Verify the file was created.
  const stat = await Deno.stat(dbPath);
  assertEquals(stat.isFile, true);

  await Deno.remove(tmpDir, { recursive: true });
});
