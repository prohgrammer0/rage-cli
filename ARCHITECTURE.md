# ARCHITECTURE.md — RAGE

This file is the source of truth for all module contracts, interfaces, and implementation details. Read this before making any changes to the codebase. If an interface changes, update this file first, then implement.

---

## Module Dependency Graph

```
src/main.ts
├── src/config/schema.ts        (types only, no imports)
├── src/config/loader.ts        (imports: schema.ts)
├── src/config/models.ts        (imports: schema.ts)
├── src/store/db.ts             (no internal imports)
├── src/store/vectors.ts        (imports: db.ts)
├── src/store/queries.ts        (imports: db.ts, vectors.ts)
├── src/providers/ollama.ts     (no internal imports)
├── src/providers/zen.ts        (no internal imports)
├── src/ingest/scanner.ts       (imports: store/queries.ts)
├── src/ingest/chunker.ts       (no internal imports)
├── src/ingest/embedder.ts      (imports: providers/ollama.ts)
├── src/ingest/pipeline.ts      (imports: scanner.ts, chunker.ts, embedder.ts, store/queries.ts, store/vectors.ts)
├── src/retrieval/search.ts     (imports: ingest/embedder.ts, store/queries.ts)
├── src/retrieval/context.ts    (imports: ingest/chunker.ts, store/queries.ts)
└── src/chat/
    ├── input.ts                (no internal imports)
    ├── renderer.ts             (imports: config/models.ts, ingest/pipeline.ts)
    ├── commands.ts             (imports: renderer.ts, config/models.ts, store/queries.ts, ingest/pipeline.ts)
    ├── line.ts                 (imports: providers/zen.ts, retrieval/search.ts, retrieval/context.ts, renderer.ts)
    ├── developmental.ts        (imports: providers/zen.ts, retrieval/search.ts, retrieval/context.ts, renderer.ts)
    └── repl.ts                 (imports: renderer.ts, commands.ts, line.ts, developmental.ts, input.ts)
```

**Rules:**
- No module imports from another module's internal files — only from the files listed above.
- `schema.ts` has zero imports from this codebase.
- Provider modules do not import from store, ingest, retrieval, or chat.

---

## TypeScript Interface Contracts

### `src/config/schema.ts`

```typescript
export type ModelRole = "line_edit" | "developmental" | "embedding";

export interface VaultEntry { path: string; name: string; }
export interface DatabaseConfig { path: string; }

export interface IngestConfig {
  chunk_size: number;        // target tokens per chunk (approximated as chars/4)
  chunk_overlap: number;     // overlap tokens between chunks
  extensions: string[];
}

export interface EmbeddingModelConfig {
  provider: "ollama";
  model: string;
  dimensions: number;
}

export interface RoleModelConfig {
  provider: "ollama" | "zen";
  default: string;
  top_k: number;             // retrieval top-K for this role
}

export interface LocalModelRegistryEntry {
  roles: ModelRole[];
  notes: string;
}

export interface CloudModelRegistryEntry {
  roles: Exclude<ModelRole, "embedding">[];
  notes: string;
}

export interface ModelsConfig {
  embedding: EmbeddingModelConfig;
  line_edit: RoleModelConfig;
  developmental: RoleModelConfig;
  registry: {
    local: Record<string, LocalModelRegistryEntry>;
    cloud: Record<string, CloudModelRegistryEntry>;
  };
}

export interface ZenConfig {
  api_key_env: string;
  base_url: string;          // e.g. "https://opencode.ai/zen/v1"
}

export interface OllamaConfig { base_url: string; }

export interface AppConfig {
  vaults: VaultEntry[];      // empty array = no vault configured
  database: DatabaseConfig;
  ingest: IngestConfig;
  models: ModelsConfig;
  zen: ZenConfig;
  ollama: OllamaConfig;
}
```

---

### `src/config/loader.ts`

```typescript
export interface CLIOverrides {
  vaultPaths?: string[];     // each becomes a VaultEntry; name = basename
  configPath?: string;
  modelLine?: string;
  modelDev?: string;
}

/**
 * Load and merge configuration.
 * Merge order (later overrides earlier):
 *   1. config.default.toml (bundled defaults)
 *   2. user --config <path> file, if provided
 *   3. CLI overrides (vault paths, model tags)
 *   4. Environment variables
 *
 * Vault resolution (later overrides earlier):
 *   [[vaults]] entries in config file
 *   --vault <path> flags (CLIOverrides.vaultPaths)
 *   RAGE_VAULT_PATHS=path1,path2  (comma-separated; names = basenames)
 *   RAGE_VAULT_PATH=path          (single vault; backward-compatible)
 *
 * Other environment variables:
 *   RAGE_DB_PATH  → config.database.path
 */
export function loadConfig(overrides: CLIOverrides): Promise<AppConfig>;
```

---

### `src/config/models.ts`

```typescript
export type ModelRole = "line_edit" | "developmental" | "embedding";
export type ModelProvider = "ollama" | "zen";

export interface ModelEntry {
  tag: string;
  provider: ModelProvider;
  roles: ModelRole[];
  available: boolean;
  notes: string;
}

export interface ModelRegistry {
  /** Cross-reference config registry entries against available models. Call once at startup. */
  initialize(ollamaModels: string[], zenModels: string[]): void;

  /** Return all available models for a given role. */
  getAvailable(role: ModelRole): ModelEntry[];

  /**
   * Resolve the active model for a role.
   * Priority: setActive override > config default > first available.
   * Returns null if nothing is available.
   */
  resolve(role: ModelRole): ModelEntry | null;

  /** Switch the active model for a role. Returns false if tag not available for that role. */
  setActive(role: ModelRole, tag: string): boolean;

  /** Return all registry entries not available at runtime. Used for WARN logs at startup. */
  getUnavailable(): ModelEntry[];
}

export function createModelRegistry(config: AppConfig): ModelRegistry;
```

---

### `src/store/db.ts`

```typescript
export interface Database {
  readonly sqlite: import("@db/sqlite").Database;
  migrate(): void;
  close(): void;
}

export function openDatabase(path: string): Database;
```

---

### `src/store/vectors.ts`

```typescript
export interface VectorStore {
  upsert(chunkId: string, embedding: Float32Array): void;
  deleteMany(chunkIds: string[]): void;
  search(queryEmbedding: Float32Array, topK: number): Array<{ id: string; distance: number }>;
}

export function createVectorStore(db: Database): VectorStore;
```

---

### `src/store/queries.ts`

```typescript
export interface ChunkRow {
  id: string;
  file_path: string;
  line_start: number;
  line_end: number;
  content: string;
  frontmatter: string | null;   // JSON string
  links: string | null;         // JSON array string
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
  countStaleFiles(vaultFiles: Array<{ path: string; mtimeMs: number }>): number;

  /** Return all file paths currently tracked in the files table. */
  getAllFilePaths(): string[];

  /**
   * Return all chunks whose file_path starts with prefix.
   * Pass a full path for a single file, or a directory path (with trailing /)
   * to get all chunks under that directory.
   */
  getChunksByPathPrefix(prefix: string): ChunkRow[];
}

export function createQueries(db: Database, vectors: VectorStore): Queries;
```

---

### `src/providers/ollama.ts`

Ollama is used for **embeddings only**. It has no chat method.

```typescript
export interface OllamaClient {
  /** GET /api/tags — returns installed model name strings. Throws if unreachable. */
  listModels(): Promise<string[]>;

  /** POST /api/embeddings — returns a Float32Array of the model's output dimensions. */
  embed(text: string, model: string): Promise<Float32Array>;
}

export function createOllamaClient(baseUrl: string): OllamaClient;
```

---

### `src/providers/zen.ts`

All chat inference goes through Zen (OpenAI-compatible API).

```typescript
export interface ZenClient {
  /**
   * GET {base_url}/models (OpenAI /models endpoint).
   * Returns array of model ID strings. Result is cached for the session.
   */
  fetchCatalog(): Promise<string[]>;

  /**
   * POST {base_url}/chat/completions (OpenAI-compatible SSE streaming).
   * Yields content delta strings as they arrive.
   */
  chat(params: {
    model: string;
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
    stream: boolean;
  }): AsyncIterable<string>;
}

export function createZenClient(baseUrl: string, apiKey: string): ZenClient;
```

---

### `src/ingest/scanner.ts`

```typescript
export interface VaultFile { path: string; mtimeMs: number; }
export type FileCategory = "new" | "modified" | "unchanged" | "deleted";

export interface ScanResult {
  new: VaultFile[];
  modified: VaultFile[];
  unchanged: VaultFile[];
  deleted: string[];
}

export interface Scanner {
  scan(vaultPath: string, extensions: string[]): Promise<ScanResult>;
  stalenessCount(vaultPath: string, extensions: string[]): Promise<number>;
}

export function createScanner(queries: Queries): Scanner;
```

---

### `src/ingest/chunker.ts`

```typescript
export interface ChunkMetadata {
  id: string;           // SHA-256(filePath + ":" + lineStart + ":" + lineEnd), hex
  filePath: string;
  lineStart: number;    // 1-indexed
  lineEnd: number;      // 1-indexed, inclusive
  content: string;
  contentHash: string;  // SHA-256(content), hex
  frontmatter: Record<string, unknown> | null;
  links: string[];
}

export interface ChunkerConfig {
  chunkSize: number;
  chunkOverlap: number;
}

export function chunkMarkdown(
  filePath: string,
  content: string,
  config: ChunkerConfig
): Promise<ChunkMetadata[]>;

export function estimateTokens(text: string): number;
```

---

### `src/ingest/embedder.ts`

```typescript
export interface Embedder {
  embed(text: string): Promise<Float32Array>;
}

export function createEmbedder(client: OllamaClient, model: string): Embedder;
```

---

### `src/ingest/pipeline.ts`

```typescript
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
  vectorStore: VectorStore
): Pipeline;
```

---

### `src/retrieval/search.ts`

```typescript
export interface RetrievalSearch {
  /** Embed the query, run similarity search, return ranked results. topK defaults to 10. */
  query(text: string, topK?: number): Promise<SearchResult[]>;

  /**
   * Fetch all chunks whose file_path starts with pathPrefix, returned at distance 0.
   * Used for @-mention explicit file/directory references.
   */
  queryByPath(pathPrefix: string): SearchResult[];
}

export function createRetrievalSearch(embedder: Embedder, queries: Queries): RetrievalSearch;
```

---

### `src/retrieval/context.ts`

```typescript
/**
 * Assemble retrieved chunks into a formatted context block for LLM prompts.
 * - Deduplicates overlapping chunks from the same file (prefer lower distance).
 * - Respects maxTokens budget; drops lowest-ranked chunks to fit.
 * - Format: --- [<filePath> L:<lineStart>-<lineEnd>] ---\n<content>
 */
export function assembleContext(results: SearchResult[], maxTokens: number): string;
```

---

### `src/chat/input.ts`

```typescript
export type InputResult =
  | { type: "submit"; text: string }
  | { type: "abort" };

/**
 * Read multi-line input from stdin in raw mode.
 *
 * - Enter (CR) submits.
 * - Shift+Enter inserts a newline (Kitty keyboard protocol: \x1b[13;2u).
 * - Backspace deletes; at the start of an empty line, merges with previous line.
 * - Ctrl+C (0x03 or \x1b[99;5u in Kitty protocol) aborts.
 * - Tab / → accepts the current ghost completion.
 * - Ghost completions shown for /commands and @file paths.
 *
 * filePaths is a sorted list of vault-relative file paths used for @ completion.
 */
export async function readMultilineInput(filePaths?: string[]): Promise<InputResult>;
```

---

### `src/chat/renderer.ts`

```typescript
export type LogLevel = "info" | "warn" | "error" | "debug";
export type EditorRole = "line" | "dev";

export interface RenderOptions { useColor: boolean; }

export interface Renderer {
  renderPrompt(role: EditorRole, model: string): string;
  log(level: LogLevel, msg: string): void;
  renderModelList(models: ModelEntry[]): void;
  renderStatus(state: StatusState): void;
  renderIngestStats(stats: IngestStats): void;
}

export interface StatusState {
  role: EditorRole;
  model: string;
  vaultPath: string;
  chunkCount: number;
  staleFileCount: number;
  dbPath: string;
}

export function createRenderer(options?: Partial<RenderOptions>): Renderer;
```

---

### `src/chat/commands.ts`

```typescript
export interface CommandContext {
  role: EditorRole;
  modelRegistry: ModelRegistry;
  queries: Queries;
  pipeline: Pipeline | null;
  pipelineOptions: PipelineOptions[] | null;  // one entry per vault
  renderer: Renderer;
  onRoleChange: (role: EditorRole) => void;
  onModelChange: (tag: string) => void;
  onQuit: () => void;
}

export type CommandResult =
  | { type: "ok" }
  | { type: "unknown"; input: string }
  | { type: "quit" };

export function handleCommand(input: string, ctx: CommandContext): Promise<CommandResult>;
```

---

### `src/chat/line.ts`

```typescript
export interface LineEditorSession {
  /**
   * Send a message to the line editor.
   * - Parses @mentions from the message to fetch explicit chunks.
   * - Runs semantic retrieval on the full message.
   * - Merges results (@-chunks first at distance 0, then semantic), deduplicates.
   * - Streams response to stdout via Zen.
   * onStart fires before the first token (used to clear the spinner).
   */
  send(message: string, onStart?: () => void): Promise<void>;

  resetHistory(): void;
}

export interface LineEditorConfig {
  model: string;
  contextMaxTokens: number;  // default 2048
  topK: number;
  vaults: VaultEntry[];      // used to resolve @-mention paths
}

export function createLineEditor(
  config: LineEditorConfig,
  retrieval: RetrievalSearch,
  zen: ZenClient,
  renderer: Renderer
): LineEditorSession;
```

---

### `src/chat/developmental.ts`

```typescript
export interface DevEditorSession {
  send(message: string, onStart?: () => void): Promise<void>;
  resetHistory(): void;
}

export interface DevEditorConfig {
  model: string;
  contextMaxTokens: number;  // default 4096
  topK: number;
  vaults: VaultEntry[];      // used to resolve @-mention paths
}

export function createDevEditor(
  config: DevEditorConfig,
  retrieval: RetrievalSearch,
  zen: ZenClient,
  renderer: Renderer
): DevEditorSession;
```

---

### `src/chat/repl.ts`

```typescript
export interface ReplConfig {
  initialRole: EditorRole;
  commandContext: CommandContext;
  lineEditor: LineEditorSession;
  devEditor: DevEditorSession;
  renderer: Renderer;
  /**
   * Called on each prompt to get vault-relative file paths for @ completion.
   * Refreshes after /ingest so newly indexed files appear immediately.
   */
  getFilePaths: () => string[];
}

/**
 * Enter the REPL loop.
 * - Reads input via readMultilineInput (raw mode, multi-line, ghost completions).
 * - Dispatches /commands to handleCommand.
 * - Dispatches plain text to the active editor session with a spinner.
 * - Ctrl+C: exits cleanly (SIGINT handler calls Deno.exit(0) outside raw mode).
 * - Blocks until the user quits.
 */
export function runRepl(config: ReplConfig): Promise<void>;
```

---

## SQLite Schema

```sql
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
  mtime_ms REAL NOT NULL,   -- REAL not INTEGER: @db/sqlite truncates large int64
  chunk_count INTEGER NOT NULL,
  last_ingested TEXT DEFAULT (datetime('now'))
);
```

Vector storage uses BLOB-stored embeddings with in-memory cosine similarity (not sqlite-vec). Same `VectorStore` interface — see AGENTS.md for rationale.

Migration strategy: numbered SQL strings applied in order. DB tracks current version in `pragma user_version`. Each migration runs in a transaction.

---

## Configuration Schema

Full default config (`config.default.toml`) maps to `AppConfig`. Key defaults:

| Key | Default |
|---|---|
| `database.path` | `./data/rage.db` |
| `ingest.chunk_size` | `512` |
| `ingest.chunk_overlap` | `64` |
| `ingest.extensions` | `[".md"]` |
| `models.embedding.model` | `nomic-embed-text:latest` |
| `models.embedding.dimensions` | `768` |
| `models.line_edit.default` | `minimax-m2.5` |
| `models.line_edit.top_k` | `10` |
| `models.developmental.default` | `kimi-k2.5` |
| `models.developmental.top_k` | `40` |
| `zen.api_key_env` | `RAGE_ZEN_API_KEY` |
| `zen.base_url` | `https://opencode.ai/zen/v1` |
| `ollama.base_url` | `http://localhost:11434` |

---

## System Prompts

Both editors inject the assembled context into the system prompt and explicitly tell the model it has no file system access or tools.

### Line Editor

```
You are a line editor reviewing markdown documents. Your job is to provide
feedback on writing at the sentence and paragraph level. You critique clarity,
word choice, rhythm, redundancy, grammar, and precision.

You NEVER rewrite the text. You point out issues and explain why they are
issues. The writer does the writing.

You have no file system access or tools. Work only from the retrieved context
below. When referencing specific text, cite the file path and line numbers from
the context.

Retrieved context:
{context}
```

### Developmental Editor

```
You are a developmental editor reviewing markdown documents. Your job is to
provide structural and argumentative feedback. You critique logical flow,
argument strength, missing perspectives, structural coherence, thematic
consistency, and whether the piece achieves what it sets out to do.

You NEVER rewrite the text. You identify problems, explain why they matter,
and describe what a solution might look like without writing it. The writer
does the writing.

You have no file system access or tools. Work only from the retrieved context
below. When referencing specific text, cite the file path and line numbers from
the context.

Retrieved context:
{context}
```

---

## @-Mention Retrieval

Both editors parse `@path` tokens from the user message before running semantic retrieval:

1. Extract all `@word/path.md` tokens (regex `/@([\w./\-]+)/g`).
2. Skip `@vault` (falls through to semantic search).
3. For each mention: resolve to a full path prefix using `resolveAtMention()`:
   - **Single vault:** `vault.path + "/" + mention`
   - **Multiple vaults:** first segment of mention is the vault name; remainder is the path within that vault
4. Call `retrieval.queryByPath(prefix)` — returns all matching chunks at `distance: 0`.
5. Run normal semantic retrieval on the full message at configured `topK`.
6. Merge: @-chunks first, then semantic results, deduplicated by chunk ID.
7. Pass merged results to `assembleContext`.

This ensures explicitly referenced files always appear in context regardless of semantic similarity.

---

## Chunking Strategy

**Token approximation:** `estimateTokens(text) = Math.ceil(text.length / 4)`

1. Parse YAML frontmatter between leading `---` delimiters.
2. Identify fenced code blocks; keep each whole.
3. Split body into segments at blank lines (`\n\n`).
4. Accumulate segments into chunks up to `chunkSize` tokens with `chunkOverlap` overlap.
5. Oversized single segments become their own chunks.
6. Chunk ID: `SHA-256(filePath + ":" + lineStart + ":" + lineEnd)` hex.
7. Content hash: `SHA-256(content)` hex.

---

## Embedding Strategy

- Model: `nomic-embed-text:latest` via Ollama `POST /api/embeddings`
- Dimensions: 768
- Input: raw chunk content (not frontmatter or link metadata)
- Content hash reuse: if chunk ID exists and content hash matches, skip re-embedding

---

## Error Reporting

Startup errors are collected into `string[]` and emitted together before exit. Runtime errors during chat are logged via `renderer.log("error", ...)` and return to the REPL prompt.

---

## Environment Variables

| Variable | Purpose |
|---|---|
| `RAGE_ZEN_API_KEY` | API key for OpenCode Zen. Required for `edit`. |
| `RAGE_VAULT_PATH` | Single vault path (backward compatible). |
| `RAGE_VAULT_PATHS` | Comma-separated vault paths. Takes precedence over `RAGE_VAULT_PATH`. |
| `RAGE_DB_PATH` | Override `database.path`. |

---

## Deno Permissions

| Permission | Reason |
|---|---|
| `--allow-read` | Vault files, config files, SQLite DB |
| `--allow-write` | SQLite DB |
| `--allow-net` | Ollama HTTP, Zen HTTP |
| `--allow-env` | Read env vars |
| `--allow-ffi` | `@db/sqlite` loads SQLite via FFI |

---

## Implementation Notes

- **No external CLI framework.** `@std/cli` for arg parsing, `@std/fmt/colors` for output. REPL is hand-rolled over `Deno.stdin` in raw mode.
- **No partial startup.** All requirements validated before the interactive loop begins.
- **Conversation history** is an in-memory `Array<{role, content}>` per session. Resets on model or role switch.
- **Streaming** writes content deltas directly to `Deno.stdout` as they arrive.
- **SQLite transactions** wrap each file's delete+insert cycle.
- **Zen catalog caching** is session-scoped. `fetchCatalog()` is called once; subsequent calls return the cached result.
- **Ghost completions** use dim ANSI escape sequences (`\x1b[2m…\x1b[0m`) with cursor-back (`\x1b[ND`). Cleared before each character and redrawn after.
- **Kitty keyboard protocol** (`\x1b[>1u`) is enabled during raw input to disambiguate Shift+Enter. Ctrl+C is handled both as raw `0x03` and as Kitty-encoded `\x1b[99;5u`.
