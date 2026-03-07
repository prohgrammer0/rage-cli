# CLAUDE.md — RAGE project notes

Read ARCHITECTURE.md before making any changes. It is the source of truth for all module interfaces.

## Implementation decisions

**Vector storage:** We use BLOB-stored embeddings with in-memory cosine similarity instead of sqlite-vec. Same `VectorStore` interface — the rest of the codebase is unaffected. Sufficient for Obsidian vault scale. See `src/store/vectors.ts`.

**Cloud-only chat:** Both editors (line and developmental) use Zen for inference. Ollama is embeddings-only. There is no offline/local chat mode.

**Token counting:** `Math.ceil(text.length / 4)` approximation. Good enough for context budgeting at this scale.

**SQLite mtime storage:** `mtime_ms REAL NOT NULL` — not INTEGER. `@db/sqlite` truncates large int64 values when bound as JavaScript numbers. Float64 is safe for all timestamps.

**`getAllFilePaths()` and `getChunksByPathPrefix()` on Queries:** Added beyond original spec. `getAllFilePaths()` required by the scanner to detect deleted files. `getChunksByPathPrefix()` required for @-mention retrieval. See `src/store/queries.ts`.

**`chunkMarkdown` is async:** Returns `Promise<ChunkMetadata[]>` because SHA-256 hashing uses `crypto.subtle.digest` which is async.

**Content-hash reuse:** Only applies globally across files, not within a modified file's own re-processing cycle. Modified files are deleted-then-reprocessed.

**@-mention retrieval:** `@path` tokens in user messages fetch chunks by file path prefix (distance=0) and are merged with semantic results, with @-chunks taking priority. `@vault` is a no-op (falls through to normal semantic search).

**Raw input / Kitty protocol:** Input uses `Deno.stdin.setRaw(true)` with Kitty keyboard protocol (`\x1b[>1u`) to distinguish Shift+Enter from Enter. Ctrl+C is handled as both raw `0x03` and Kitty-encoded `\x1b[99;5u`.

**Zen env var name:** `RAGE_ZEN_API_KEY`.

## Running

```bash
deno task test          # run all tests
deno task ingest        # index vault (vault path from .env or RAGE_VAULT_PATH)
deno task edit          # start editing session
```

Vault path, API key, and DB path are read from `.env` via `--env-file`. See `config.default.toml` for all defaults.

## Test permissions

All tests require: `--allow-read --allow-write --allow-net --allow-env --allow-ffi`

The `--allow-ffi` flag is needed by `@db/sqlite` which loads SQLite via FFI.

## Module boundaries

No module may import from another module's internals. Import chain:
`main.ts` → `config/` → `store/` → `providers/` → `ingest/` → `retrieval/` → `chat/`
