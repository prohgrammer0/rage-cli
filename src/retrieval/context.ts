import type { SearchResult } from "../store/queries.ts";
import { estimateTokens } from "../ingest/chunker.ts";

/**
 * Assemble retrieved chunks into a context block for LLM prompts.
 *
 * Rules:
 *   1. Deduplicate overlapping chunks from the same file: if two chunks from
 *      the same file have overlapping line ranges, keep the one with lower
 *      distance (higher similarity).
 *   2. Respect maxTokens budget; drop lowest-ranked (highest distance) chunks
 *      to fit.
 *   3. Format each chunk as:
 *        --- [<filePath> L:<lineStart>-<lineEnd>] ---
 *        <content>
 */
export function assembleContext(
  results: SearchResult[],
  maxTokens: number,
): string {
  if (results.length === 0) return "";

  // 1. Deduplicate: per-file, remove chunks whose line range overlaps with
  //    a higher-ranked chunk (lower distance = better rank).
  const deduped = deduplicateByFileOverlap(results);

  // 2. Apply token budget: keep the highest-ranked chunks that fit.
  const selected: SearchResult[] = [];
  let tokenCount = 0;

  for (const chunk of deduped) {
    const header = `--- [${chunk.file_path} L:${chunk.line_start}-${chunk.line_end}] ---`;
    const chunkTokens = estimateTokens(header + "\n" + chunk.content + "\n\n");
    if (tokenCount + chunkTokens > maxTokens && selected.length > 0) {
      break; // budget exhausted
    }
    selected.push(chunk);
    tokenCount += chunkTokens;
  }

  // 3. Format.
  return selected
    .map((chunk) =>
      `--- [${chunk.file_path} L:${chunk.line_start}-${chunk.line_end}] ---\n${chunk.content}`
    )
    .join("\n\n");
}

function deduplicateByFileOverlap(results: SearchResult[]): SearchResult[] {
  // Group by file, then remove overlapping chunks keeping lower-distance ones.
  // Results are already sorted by distance ascending (best first).
  const kept: SearchResult[] = [];

  for (const candidate of results) {
    const overlaps = kept.some(
      (existing) =>
        existing.file_path === candidate.file_path &&
        rangesOverlap(
          existing.line_start,
          existing.line_end,
          candidate.line_start,
          candidate.line_end,
        ),
    );
    if (!overlaps) {
      kept.push(candidate);
    }
  }

  return kept;
}

function rangesOverlap(
  startA: number,
  endA: number,
  startB: number,
  endB: number,
): boolean {
  return startA <= endB && startB <= endA;
}
