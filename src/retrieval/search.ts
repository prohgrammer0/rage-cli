import type { Embedder } from "../ingest/embedder.ts";
import type { Queries, SearchResult } from "../store/queries.ts";

export interface RetrievalSearch {
  query(text: string, topK?: number): Promise<SearchResult[]>;
  /** Fetch all chunks whose file_path starts with prefix, ranked at distance 0. */
  queryByPath(pathPrefix: string): SearchResult[];
}

export function createRetrievalSearch(
  embedder: Embedder,
  queries: Queries,
): RetrievalSearch {
  return {
    async query(text: string, topK = 10): Promise<SearchResult[]> {
      const embedding = await embedder.embed(text);
      return queries.search(embedding, topK);
    },

    queryByPath(pathPrefix: string): SearchResult[] {
      return queries.getChunksByPathPrefix(pathPrefix).map((chunk) => ({
        ...chunk,
        distance: 0,
      }));
    },
  };
}
