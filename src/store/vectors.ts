import type { Database } from "./db.ts";

/**
 * Vector storage and similarity search.
 *
 * The spec calls for sqlite-vec (vec0 virtual table). For the prototype,
 * we store embeddings as raw BLOB and compute cosine similarity in TypeScript.
 * This is equivalent for Obsidian vault scale (<100K chunks) and requires
 * no native extension. The VectorStore interface is unchanged — the rest of
 * the codebase is unaffected if sqlite-vec is wired in later.
 */

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function float32ToBlob(arr: Float32Array): Uint8Array {
  return new Uint8Array(arr.buffer.slice(0));
}

function blobToFloat32(buf: Uint8Array): Float32Array {
  // @db/sqlite returns BLOB columns as Uint8Array.
  // Ensure we have a properly aligned buffer.
  const aligned = buf.buffer.byteLength === buf.byteLength &&
      buf.byteOffset === 0
    ? buf.buffer
    : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Float32Array(aligned);
}

export interface VectorStore {
  upsert(chunkId: string, embedding: Float32Array): void;
  deleteMany(chunkIds: string[]): void;
  search(
    queryEmbedding: Float32Array,
    topK: number,
  ): Array<{ id: string; distance: number }>;
}

export function createVectorStore(db: Database): VectorStore {
  const { sqlite } = db;

  const stmtUpsert = sqlite.prepare(
    "INSERT OR REPLACE INTO embeddings (chunk_id, vector) VALUES (?, ?)",
  );

  const stmtAll = sqlite.prepare(
    "SELECT chunk_id, vector FROM embeddings",
  );

  return {
    upsert(chunkId: string, embedding: Float32Array): void {
      stmtUpsert.run(chunkId, float32ToBlob(embedding));
    },

    deleteMany(chunkIds: string[]): void {
      if (chunkIds.length === 0) return;
      // SQLite's IN clause limit is 999 parameters. Batch if needed.
      const batchSize = 900;
      for (let i = 0; i < chunkIds.length; i += batchSize) {
        const batch = chunkIds.slice(i, i + batchSize);
        const placeholders = batch.map(() => "?").join(",");
        sqlite.prepare(
          `DELETE FROM embeddings WHERE chunk_id IN (${placeholders})`,
        ).run(...batch);
      }
    },

    search(
      queryEmbedding: Float32Array,
      topK: number,
    ): Array<{ id: string; distance: number }> {
      const rows = stmtAll.all<{ chunk_id: string; vector: Uint8Array }>();

      const scored = rows.map((row) => {
        const vec = blobToFloat32(row.vector);
        const similarity = cosineSimilarity(queryEmbedding, vec);
        return { id: row.chunk_id, distance: 1 - similarity };
      });

      scored.sort((a, b) => a.distance - b.distance);
      return scored.slice(0, topK);
    },
  };
}
