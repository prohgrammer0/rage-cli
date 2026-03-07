import { Database as SqliteDatabase } from "@db/sqlite";

/**
 * Migrations are applied in order. Each is a single SQL string
 * (may contain multiple statements). Version tracked via PRAGMA user_version.
 */
const MIGRATIONS: string[] = [
  // Version 1: initial schema
  `
  CREATE TABLE IF NOT EXISTS chunks (
    id TEXT PRIMARY KEY,
    file_path TEXT NOT NULL,
    line_start INTEGER NOT NULL,
    line_end INTEGER NOT NULL,
    content TEXT NOT NULL,
    frontmatter TEXT,
    links TEXT,
    content_hash TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_path);
  CREATE INDEX IF NOT EXISTS idx_chunks_hash ON chunks(content_hash);

  CREATE TABLE IF NOT EXISTS files (
    path TEXT PRIMARY KEY,
    mtime_ms REAL NOT NULL,
    chunk_count INTEGER NOT NULL,
    last_ingested TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS embeddings (
    chunk_id TEXT PRIMARY KEY,
    vector BLOB NOT NULL
  );
  `,
];

export interface Database {
  readonly sqlite: SqliteDatabase;
  migrate(): void;
  close(): void;
}

export function openDatabase(path: string): Database {
  // Ensure parent directory exists (unless in-memory).
  if (path !== ":memory:") {
    const dir = path.includes("/")
      ? path.substring(0, path.lastIndexOf("/"))
      : null;
    if (dir) {
      try {
        Deno.mkdirSync(dir, { recursive: true });
      } catch {
        // ignore if already exists
      }
    }
  }

  const sqlite = new SqliteDatabase(path);

  return {
    sqlite,

    migrate(): void {
      const row = sqlite.prepare("PRAGMA user_version").get<
        { user_version: number }
      >();
      let currentVersion = row?.user_version ?? 0;

      for (let i = currentVersion; i < MIGRATIONS.length; i++) {
        sqlite.exec(MIGRATIONS[i]);
        currentVersion = i + 1;
        sqlite.exec(`PRAGMA user_version = ${currentVersion}`);
      }
    },

    close(): void {
      sqlite.close();
    },
  };
}
