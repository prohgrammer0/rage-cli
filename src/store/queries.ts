import type { Database } from "./db.ts";
import type { VectorStore } from "./vectors.ts";

export interface ChunkRow {
  id: string;
  file_path: string;
  line_start: number;
  line_end: number;
  content: string;
  frontmatter: string | null;
  links: string | null;
  content_hash: string;
  created_at: string;
  updated_at: string;
}

export interface FileState {
  path: string;
  mtime_ms: number;
  chunk_count: number;
  last_ingested: string;
}

export interface SearchResult extends ChunkRow {
  distance: number;
}

export interface Queries {
  upsertChunk(chunk: Omit<ChunkRow, "created_at" | "updated_at">): void;
  pruneFile(filePath: string): string[];
  getChunk(id: string): ChunkRow | null;
  getChunkIdsByFile(filePath: string): string[];
  search(queryEmbedding: Float32Array, topK: number): SearchResult[];
  getFileState(filePath: string): FileState | null;
  setFileState(filePath: string, mtimeMs: number, chunkCount: number): void;
  hasChunks(): boolean;
  countStaleFiles(
    vaultFiles: Array<{ path: string; mtimeMs: number }>,
  ): number;

  /** Return all file paths currently tracked in the files table. */
  getAllFilePaths(): string[];

  /**
   * Return all chunks whose file_path starts with the given prefix.
   * Use a full path for a single file, or a directory path (with trailing /)
   * to get all chunks under that directory.
   */
  getChunksByPathPrefix(prefix: string): ChunkRow[];
}

export function createQueries(db: Database, vectors: VectorStore): Queries {
  const { sqlite } = db;

  const stmtUpsertChunk = sqlite.prepare(`
    INSERT INTO chunks (id, file_path, line_start, line_end, content, frontmatter, links, content_hash, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      file_path = excluded.file_path,
      line_start = excluded.line_start,
      line_end = excluded.line_end,
      content = excluded.content,
      frontmatter = excluded.frontmatter,
      links = excluded.links,
      content_hash = excluded.content_hash,
      updated_at = excluded.updated_at
  `);

  const stmtGetChunkIdsByFile = sqlite.prepare(
    "SELECT id FROM chunks WHERE file_path = ?",
  );

  const stmtDeleteChunksByFile = sqlite.prepare(
    "DELETE FROM chunks WHERE file_path = ?",
  );

  const stmtGetChunk = sqlite.prepare(
    "SELECT * FROM chunks WHERE id = ?",
  );

  const stmtGetFileState = sqlite.prepare(
    "SELECT * FROM files WHERE path = ?",
  );

  const stmtUpsertFileState = sqlite.prepare(`
    INSERT INTO files (path, mtime_ms, chunk_count, last_ingested)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(path) DO UPDATE SET
      mtime_ms = excluded.mtime_ms,
      chunk_count = excluded.chunk_count,
      last_ingested = excluded.last_ingested
  `);

  const stmtHasChunks = sqlite.prepare(
    "SELECT 1 FROM chunks LIMIT 1",
  );

  const stmtAllFiles = sqlite.prepare(
    "SELECT path, mtime_ms FROM files",
  );

  const stmtAllFilePaths = sqlite.prepare("SELECT path FROM files");

  const stmtChunksByPathPrefix = sqlite.prepare(
    "SELECT * FROM chunks WHERE file_path LIKE ? || '%'",
  );

  return {
    upsertChunk(chunk: Omit<ChunkRow, "created_at" | "updated_at">): void {
      stmtUpsertChunk.run(
        chunk.id,
        chunk.file_path,
        chunk.line_start,
        chunk.line_end,
        chunk.content,
        chunk.frontmatter,
        chunk.links,
        chunk.content_hash,
      );
    },

    pruneFile(filePath: string): string[] {
      const rows = stmtGetChunkIdsByFile.all<{ id: string }>(filePath);
      const ids = rows.map((r) => r.id);
      if (ids.length > 0) {
        vectors.deleteMany(ids);
        stmtDeleteChunksByFile.run(filePath);
      }
      return ids;
    },

    getChunk(id: string): ChunkRow | null {
      return stmtGetChunk.get<ChunkRow>(id) ?? null;
    },

    getChunkIdsByFile(filePath: string): string[] {
      return stmtGetChunkIdsByFile.all<{ id: string }>(filePath).map((r) =>
        r.id
      );
    },

    search(queryEmbedding: Float32Array, topK: number): SearchResult[] {
      const hits = vectors.search(queryEmbedding, topK);
      const results: SearchResult[] = [];

      for (const hit of hits) {
        const row = stmtGetChunk.get<ChunkRow>(hit.id);
        if (row) {
          results.push({ ...row, distance: hit.distance });
        }
      }

      return results;
    },

    getFileState(filePath: string): FileState | null {
      return stmtGetFileState.get<FileState>(filePath) ?? null;
    },

    setFileState(
      filePath: string,
      mtimeMs: number,
      chunkCount: number,
    ): void {
      stmtUpsertFileState.run(filePath, mtimeMs, chunkCount);
    },

    hasChunks(): boolean {
      return stmtHasChunks.get() !== undefined;
    },

    countStaleFiles(
      vaultFiles: Array<{ path: string; mtimeMs: number }>,
    ): number {
      const dbFiles = new Map<string, number>(
        stmtAllFiles.all<{ path: string; mtime_ms: number }>().map((r) => [
          r.path,
          r.mtime_ms,
        ]),
      );

      const vaultPaths = new Set(vaultFiles.map((f) => f.path));

      let stale = 0;

      // New or modified files.
      for (const { path, mtimeMs } of vaultFiles) {
        const dbMtime = dbFiles.get(path);
        if (dbMtime === undefined || dbMtime !== mtimeMs) stale++;
      }

      // Deleted files (in DB but not on disk).
      for (const path of dbFiles.keys()) {
        if (!vaultPaths.has(path)) stale++;
      }

      return stale;
    },

    getAllFilePaths(): string[] {
      return stmtAllFilePaths.all<{ path: string }>().map((r) => r.path);
    },

    getChunksByPathPrefix(prefix: string): ChunkRow[] {
      return stmtChunksByPathPrefix.all<ChunkRow>(prefix);
    },
  };
}
