import type { Scanner } from "./scanner.ts";
import type { Embedder } from "./embedder.ts";
import type { Queries } from "../store/queries.ts";
import type { VectorStore } from "../store/vectors.ts";
import { chunkMarkdown } from "./chunker.ts";

export interface IngestStats {
  filesScanned: number;
  filesSkipped: number;
  filesProcessed: number;
  filesPruned: number;
  chunksCreated: number;
  chunksReused: number;
  chunksPruned: number;
}

export interface PipelineOptions {
  vaultPath: string;
  extensions: string[];
  chunkSize: number;
  chunkOverlap: number;
  embeddingModel: string;
}

export interface Pipeline {
  run(options: PipelineOptions): Promise<IngestStats>;
}

export function createPipeline(
  scanner: Scanner,
  embedder: Embedder,
  queries: Queries,
  vectorStore: VectorStore,
): Pipeline {
  return {
    async run(options: PipelineOptions): Promise<IngestStats> {
      const stats: IngestStats = {
        filesScanned: 0,
        filesSkipped: 0,
        filesProcessed: 0,
        filesPruned: 0,
        chunksCreated: 0,
        chunksReused: 0,
        chunksPruned: 0,
      };

      const scanResult = await scanner.scan(options.vaultPath, options.extensions);
      stats.filesScanned = scanResult.new.length +
        scanResult.modified.length +
        scanResult.unchanged.length +
        scanResult.deleted.length;

      // 1. Prune deleted files.
      for (const filePath of scanResult.deleted) {
        const pruned = queries.pruneFile(filePath);
        stats.chunksPruned += pruned.length;
        stats.filesPruned++;
      }

      // 2. Prune modified files (delete existing chunks before reprocessing).
      for (const file of scanResult.modified) {
        const pruned = queries.pruneFile(file.path);
        stats.chunksPruned += pruned.length;
      }

      // 3. Process new and modified files.
      const toProcess = [...scanResult.new, ...scanResult.modified];
      stats.filesSkipped = scanResult.unchanged.length;
      stats.filesProcessed = toProcess.length;

      for (const file of toProcess) {
        const content = await Deno.readTextFile(file.path);
        const chunks = await chunkMarkdown(file.path, content, {
          chunkSize: options.chunkSize,
          chunkOverlap: options.chunkOverlap,
        });

        for (const chunk of chunks) {
          // Check if a chunk with this content hash already exists at this position.
          const existing = queries.getChunk(chunk.id);
          if (existing && existing.content_hash === chunk.contentHash) {
            // Content unchanged — reuse existing embedding.
            stats.chunksReused++;
          } else {
            // New or changed content — embed and store.
            const embedding = await embedder.embed(chunk.content);
            vectorStore.upsert(chunk.id, embedding);
            queries.upsertChunk({
              id: chunk.id,
              file_path: chunk.filePath,
              line_start: chunk.lineStart,
              line_end: chunk.lineEnd,
              content: chunk.content,
              frontmatter: chunk.frontmatter
                ? JSON.stringify(chunk.frontmatter)
                : null,
              links: chunk.links.length > 0
                ? JSON.stringify(chunk.links)
                : null,
              content_hash: chunk.contentHash,
            });
            stats.chunksCreated++;
          }
        }

        queries.setFileState(file.path, file.mtimeMs, chunks.length);
      }

      return stats;
    },
  };
}
