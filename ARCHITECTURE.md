# ARCHITECTURE.md — RAGE

This file is the source of truth for all module contracts, interfaces, and
implementation details. Read this before making any changes to the codebase. If
an interface changes, update this file first, then implement.

---

## Module Dependency Graph

```
src/main.ts
├── src/config/schema.ts        (types only, no imports)
├── src/config/loader.ts        (imports: schema.ts)
├── src/config/models.ts        (imports: schema.ts)
├── src/providers/zen.ts        (no internal imports)
├── src/project/context.ts      (imports: config/schema.ts types)
├── src/sessions/store.ts       (no internal imports)
└── src/chat/
    ├── history.ts              (no internal imports)
    ├── input.ts                (imports: history.ts)
    ├── markdown.ts             (no internal imports)
    ├── renderer.ts             (imports: config/models.ts, sessions/store.ts types, providers/zen.ts types, markdown.ts)
    ├── stream.ts               (no internal imports)
    ├── commands.ts             (imports: renderer.ts, config/models.ts)
    ├── line.ts                 (imports: providers/zen.ts, project/context.ts types, sessions/store.ts types, renderer.ts, stream.ts, markdown.ts)
    ├── developmental.ts        (imports: providers/zen.ts, project/context.ts types, sessions/store.ts types, renderer.ts, stream.ts, markdown.ts)
    └── repl.ts                 (imports: renderer.ts, commands.ts, line.ts, developmental.ts, input.ts, sessions/store.ts, project/context.ts types)
```

**Rules:**

- No RAG, embeddings, vector DB, or local chat mode.
- SQLite is used only for durable session metadata and messages. Project content
  never enters SQLite.
- `schema.ts` has zero imports from this codebase.
- Provider modules do not import from config, project, or chat.
- Chat modules do not read files directly; they receive a prebuilt project
  context pack from `main.ts`.

---

## TypeScript Interface Contracts

### `src/config/schema.ts`

```typescript
export type ModelRole = "line_edit" | "developmental";

export interface VaultEntry {
  path: string;
  name: string;
}

export interface ProjectSourceEntry {
  path: string;
  name?: string;
}

export interface ProjectProfileConfig {
  sources: ProjectSourceEntry[];
}

export interface ContextConfig {
  sources: ProjectSourceEntry[];
  extensions: string[];
  max_tokens: number;
  cache: boolean;
}

export interface SessionsConfig {
  enabled: boolean;
  path: string;
}

export interface RoleModelConfig {
  provider: "zen";
  default: string;
}

// USD per million tokens. cache_read/cache_write default to the input rate
// when omitted.
export interface ModelPriceConfig {
  input: number;
  output: number;
  cache_read?: number;
  cache_write?: number;
}

export interface CloudModelRegistryEntry {
  roles: ModelRole[];
  notes: string;
  price?: ModelPriceConfig;
}

// Provenance of the registry price data. Logged once at session start so the
// user knows how stale the rates are and where to refresh them from.
export interface PricingMetaConfig {
  updated: string; // ISO date the prices were last verified
  source: string; // URL the prices were taken from
}

export interface ModelsConfig {
  line_edit: RoleModelConfig;
  developmental: RoleModelConfig;
  pricing?: PricingMetaConfig;
  registry: {
    cloud: Record<string, CloudModelRegistryEntry>;
  };
}

export interface ZenConfig {
  api_key_env: string;
  base_url: string;
}

export interface AppConfig {
  selected_project?: string;
  projects: Record<string, ProjectProfileConfig>;
  vaults: VaultEntry[];
  context: ContextConfig;
  sessions: SessionsConfig;
  models: ModelsConfig;
  zen: ZenConfig;
}
```

---

### `src/config/loader.ts`

```typescript
export interface CLIOverrides {
  vaultPaths?: string[];
  configPath?: string;
  project?: string;
  modelLine?: string;
  modelDev?: string;
}

/**
 * Load and merge configuration.
 * Merge order (later overrides earlier):
 *   1. config.default.toml
 *   2. user --config <path> file, if provided
 *   3. CLI overrides (vault paths, model tags)
 *   4. Environment variables
 *
 * Context source resolution:
 *   --project <name> / RAGE_PROJECT selects [projects.<name>] sources only
 *   [[context.sources]] entries in config file
 *   [[vaults]] entries in config file (backward-compatible directory shorthand)
 *   --vault <path> flags (backward-compatible directory shorthand)
 *   RAGE_VAULT_PATHS=path1,path2
 *   RAGE_VAULT_PATH=path
 */
export function loadConfig(overrides: CLIOverrides): Promise<AppConfig>;
```

---

### `src/config/models.ts`

```typescript
export type ModelRole = "line_edit" | "developmental";
export type ModelProvider = "zen";

export interface ModelEntry {
  tag: string;
  provider: ModelProvider;
  roles: ModelRole[];
  available: boolean;
  notes: string;
  price?: ModelPriceConfig; // from config registry; absent = cost unknown
}

export interface ModelRegistry {
  initialize(zenModels: string[]): void;
  getAvailable(role: ModelRole): ModelEntry[];
  resolve(role: ModelRole): ModelEntry | null;
  setActive(role: ModelRole, tag: string): boolean;
  getUnavailable(): ModelEntry[];
}

export function createModelRegistry(config: AppConfig): ModelRegistry;
```

---

### `src/providers/zen.ts`

All chat inference goes through Zen. Claude and Qwen models use Zen's
Anthropic-compatible `/messages` endpoint so the stable project context can be
marked cacheable. GPT models use `/responses`, Gemini models use
`/models/{model}:generateContent` or `/models/{model}:streamGenerateContent`,
and OpenAI-compatible models use `/chat/completions`.

Thinking display is normalized across protocols. Claude requests use adaptive
thinking with summarized display, GPT requests ask for automatic reasoning
summaries, Gemini requests set `includeThoughts`, and OpenAI-compatible
responses are inspected for reasoning delta fields. Complete thinking text is
rendered in a paced dimmed block before the answer and is not added to text
conversation history.

```typescript
// Normalized across protocols: inputTokens excludes cache reads/writes.
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface ZenClient {
  fetchCatalog(): Promise<string[]>;

  chat(params: {
    model: string;
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
    stream: boolean;
    maxTokens?: number;
    cacheSystemPrompt?: boolean;
    signal?: AbortSignal;
    onThinking?: (text: string) => void;
    onUsage?: (usage: TokenUsage) => void;
  }): AsyncIterable<string>;
}

export function createZenClient(baseUrl: string, apiKey: string): ZenClient;
```

`onUsage` may be called multiple times during a stream with cumulative totals;
the last call wins. Providers that include cached tokens inside their prompt
count (OpenAI-compatible, Gemini) are normalized so `inputTokens` is the
uncached share. Anthropic `message_start`/`message_delta` usage is merged. Usage
is best-effort: if a provider sends none, `onUsage` is never called.

---

### `src/project/context.ts`

```typescript
export interface ProjectContextFile {
  path: string; // display path (used for citations and @-completion)
  absolutePath: string; // filesystem path, kept for targeted reload
  block: string; // this file's formatted section of pack.content
  tokenCount: number;
}

export interface ProjectContextPack {
  content: string; // header + every file block + footer
  tokenCount: number;
  contextHash: string;
  files: ProjectContextFile[];
  filesSkipped: number;
}

export interface ProjectContextOptions {
  sources: ProjectSourceEntry[];
  vaults: VaultEntry[];
  extensions: string[];
  maxTokens: number;
}

export function buildProjectContextPack(
  options: ProjectContextOptions,
): Promise<ProjectContextPack>;

// Targeted reload: re-reads one already-included file from disk, splices its
// fresh block into a new pack, and recomputes totals and contextHash. Other
// files keep their in-pack content. Throws if the display path is not in the
// pack, the file cannot be read, or the updated pack would exceed maxTokens —
// the caller keeps the old pack on throw. If the same disk state is later
// fully rebuilt, the contextHash matches.
export function updateContextPackFile(
  pack: ProjectContextPack,
  displayPath: string,
  maxTokens: number,
): Promise<ProjectContextPack>;

export function estimateTokens(text: string): number;
```

Project context pack rules:

- Expand configured `context.sources` entries directly. A source path may be an
  exact file, directory, or simple `*`/`**` glob, and may live outside the app
  directory.
- If a project profile is selected, its `sources` replace global
  `context.sources` and legacy vault shorthand sources for that run.
- `vaults` remains as a backward-compatible directory source shorthand.
- Skip hidden files/directories while walking directories and globs, including
  `.obsidian`.
- Directory and glob sources include only configured extensions; exact file
  sources are included explicitly regardless of extension.
- Sort by displayed context path for byte-stable output.
- Format each file with a path header and 1-indexed line numbers.
- Never include timestamps or query-specific text.
- Stop before `maxTokens`; skipped files are counted and reported.
- Hash the final content with SHA-256 for session-resume change detection.

---

### `src/sessions/store.ts`

```typescript
export type SessionEditorRole = "line" | "dev";
export type SessionMessageRole = "user" | "assistant";

export interface SessionMessage {
  role: SessionMessageRole;
  content: string;
}

export interface SessionRecord {
  id: number;
  project: string;
  sourceLabel: string;
  editorRole: SessionEditorRole;
  model: string;
  contextHash: string;
  createdAt: string;
  updatedAt: string;
  messages: SessionMessage[];
}

export interface SessionSummary extends Omit<SessionRecord, "messages"> {
  messageCount: number;
  preview: string;
}

export interface SessionStore {
  create(input: {
    project: string;
    sourceLabel: string;
    editorRole: SessionEditorRole;
    model: string;
    contextHash: string;
  }): SessionRecord;
  appendTurn(sessionId: number, user: string, assistant: string): void;
  get(sessionId: number): SessionRecord | null;
  list(project?: string, limit?: number): SessionSummary[];
  close(): void;
}

export function createSessionStore(path: string): Promise<SessionStore>;
```

The session database stores normalized session metadata and user/assistant text
only. It never stores project files, project context packs, API keys, thinking
summaries, embeddings, or retrieval data. Writes are transactional. The schema
is initialized and versioned by `createSessionStore`; databases newer than the
supported schema version are rejected rather than modified.

---

### `src/chat/input.ts`

```typescript
export interface InputOptions {
  filePaths?: string[];
  history?: PromptHistory;
  prompt?: string;
}

export type InputResult =
  | { type: "submit"; text: string }
  | { type: "abort" };

export function getGhost(
  lines: string[],
  filePaths: string[],
): string;

export async function readMultilineInput(
  options?: InputOptions,
): Promise<InputResult>;
```

Input behavior:

- Enter submits.
- Shift+Enter inserts a newline.
- Bracketed paste preserves embedded newlines as one prompt.
- Ctrl+C aborts.
- ↑ / ↓ navigate prompt history for the current session.
- Tab / → accepts ghost completion.
- Ghost completions are shown for `/commands`, `/role` arguments, and `@paths`.

---

### `src/chat/markdown.ts`

Streaming markdown styler for terminal output. Consumes raw model deltas and
returns ANSI-styled text ready to write. Stateful across pushes: it classifies
each source line (heading, bullet, quote, fence, rule, text) from its prefix,
word-wraps prose to the terminal width with hanging indents, and styles inline
`` `code` `` and `**bold**` spans, holding back at most a short unresolved span
until its closer arrives so streaming stays incremental.

```typescript
export interface MarkdownStreamOptions {
  useColor?: boolean; // default: Deno.stdout.isTerminal()
  width?: number; // wrap width in columns; default min(consoleSize, 100), fallback 80
  marker?: string; // e.g. "●" — emitted (cyan) before the first line; continuation lines get matching space indent
}

export interface MarkdownStream {
  push(chunk: string): string; // returns styled output (may be "")
  end(): string; // flushes any held-back span; returns final output
}

export function createMarkdownStream(
  options?: MarkdownStreamOptions,
): MarkdownStream;

// One-shot convenience for already-complete text (session transcripts).
export function styleMarkdown(
  text: string,
  options?: MarkdownStreamOptions,
): string;
```

Rendering rules:

- Headings: `#` markers stripped, text bold cyan.
- Bullets: `-`/`*`/`+` become a cyan `•`; numbered markers cyan; nested
  indentation preserved; wrapped lines get hanging indent.
- Blockquotes: `>` becomes a dim `│` gutter, text dim.
- Fenced code: fence lines swallowed, content dim, no wrapping or inline parsing
  inside.
- `---`/`***`/`___` alone on a line: dim horizontal rule.
- Inline `` ` `` and `**` markers are stripped; code renders cyan, bold bold.
- Raw ESC (0x1b) bytes in model text are stripped.
- The returned styled text is display-only; callers must persist the raw text.

---

### `src/chat/stream.ts`

```typescript
export interface StreamTransform {
  push(chunk: string): string;
  end(): string;
}

export interface StreamTextOptions {
  onStart?: () => void | Promise<void>;
  write?: (text: string) => void;
  flushIntervalMs?: number;
  flushAtChars?: number;
  transform?: StreamTransform; // applied to written output only; the returned full text stays raw
}

export function renderTextStream(
  chunks: AsyncIterable<string>,
  options?: StreamTextOptions,
): Promise<string>; // resolves to the full RAW response text

export interface ThinkingDisplay {
  append(text: string): void;
  finish(): Promise<void>;
}

export function createThinkingDisplay(
  options?: ThinkingDisplayOptions,
): ThinkingDisplay;
```

`renderTextStream` coalesces deltas into terminal-sized writes. When a
`transform` is provided it is fed each flushed batch and its output is written
instead; `transform.end()` is flushed after the source completes. The resolved
string is always the raw, untransformed response (session history must store raw
markdown).

`createThinkingDisplay` renders reasoning as a visually distinct block: a dim
`✻ thinking` header, then every line prefixed with a dim `│` gutter. If the
thinking text ends mid-gutter (trailing newline), `finish()` erases the dangling
gutter before emitting the closing gap.

---

### `src/chat/renderer.ts`

```typescript
export type LogLevel = "info" | "warn" | "error" | "debug";
export type EditorRole = "line" | "dev";

export interface StatusState {
  role: EditorRole;
  model: string;
  sourceLabel: string;
  fileCount: number;
  contextTokens: number;
  sessionId?: number;
}

export interface ResponseStats {
  elapsedMs: number;
  approxTokens: number; // fallback display when usage is unavailable
  inputTokens?: number; // includes cache reads/writes
  outputTokens?: number;
  costUsd?: number; // omitted from display when undefined
  model: string;
}

export interface Renderer {
  renderPrompt(role: EditorRole, model: string): string;
  log(level: LogLevel, msg: string): void;
  renderModelList(models: ModelEntry[]): void;
  renderStatus(state: StatusState): void;
  renderSessionList(sessions: SessionSummary[]): void;
  renderTranscript(messages: SessionMessage[]): void;
  renderResponseFooter(stats: ResponseStats): void;
  renderTurnDivider(): void;
}

export function createRenderer(options?: Partial<RenderOptions>): Renderer;

// Maps provider usage + config price onto footer stats. Displayed inputTokens
// is the full prompt (uncached + cache reads/writes); cost prices each bucket,
// cache rates defaulting to the input rate.
export function responseUsageStats(
  usage: TokenUsage | null,
  price: ModelPriceConfig | undefined,
): Pick<ResponseStats, "inputTokens" | "outputTokens" | "costUsd">;
```

Turn anatomy — each visual element marks one section of a turn so prompts,
reasoning, and responses read as distinct blocks:

- Prompt: dim `<role> · <model>` metadata followed by a cyan `❯`.
- Thinking: dim `✻ thinking` header with a dim `│` gutter on each line (emitted
  by `createThinkingDisplay` in `stream.ts`).
- Response: cyan `●` marker, indented styled markdown body.
- Footer: `renderResponseFooter` prints one dim line after a completed response:
  `↳ 3.2s · 18.2k→1.4k tokens · $0.021 · <model>`. Token counts come from
  provider usage (`in→out`) with `~N tokens` as the estimate fallback; cost
  appears only when the active model has a `price` in the config registry.
  Editors call it only on success (not on cancel or error).
- Divider: `renderTurnDivider` prints a dim full-width `─` rule; the REPL emits
  it before every prompt except the first.

`renderTranscript` renders assistant messages through `styleMarkdown` with the
same `●` marker used for live streaming, and user messages with a cyan `❯`
prefix, so resumed sessions look identical to live ones.

---

### `src/chat/commands.ts`

```typescript
export interface CommandContext {
  role: EditorRole;
  modelRegistry: ModelRegistry;
  sourceLabel: string;
  fileCount: number;
  contextTokens: number;
  renderer: Renderer;
  onRoleChange: (role: EditorRole) => void;
  onModelChange: (tag: string) => void;
  onListSessions: () => void;
  onResumeSession: (id: number) => void;
  onReloadContext: (target?: string) => Promise<void>;
  getSessionId: () => number | null;
  onQuit: () => void;
}

export type CommandResult =
  | { type: "ok" }
  | { type: "unknown"; input: string }
  | { type: "quit" };

export function handleCommand(
  input: string,
  ctx: CommandContext,
): Promise<CommandResult>;
```

Commands:

- `/role <line|dev>`
- `/model [<tag>]`
- `/status`
- `/sessions`
- `/resume <id>`
- `/reload [@path]`
- `/help`
- `/quit` or `/exit`

`/reload` re-reads the configured sources and swaps the fresh context pack into
both editors. With an argument (`/reload @roh/drafts/essay.md`, leading `@`
optional), only that already-included file is re-read and spliced in — faster
than a full rebuild and it doesn't pick up unrelated dirty files. In both forms
the conversation is kept — the point of reloading is to keep talking about the
revised text — but the next prompt rewrites the provider prompt cache, which the
log line says explicitly. Failures (missing file, unknown path, budget exceeded)
leave the old pack in place.

---

### `src/chat/line.ts`

```typescript
export interface LineEditorSession {
  send(
    message: string,
    onStart?: () => void,
    signal?: AbortSignal,
  ): Promise<string | null>;
  resetHistory(): void;
  restoreHistory(messages: SessionMessage[]): void;
}

export interface LineEditorConfig {
  getModel: () => string;
  getPrice: () => ModelPriceConfig | undefined;
  getProjectContext: () => ProjectContextPack; // re-read each send; /reload swaps it
  cacheProjectContext: boolean;
}

export function createLineEditor(
  config: LineEditorConfig,
  zen: ZenClient,
  renderer: Renderer,
): LineEditorSession;
```

---

### `src/chat/developmental.ts`

```typescript
export interface DevEditorSession {
  send(
    message: string,
    onStart?: () => void,
    signal?: AbortSignal,
  ): Promise<string | null>;
  resetHistory(): void;
  restoreHistory(messages: SessionMessage[]): void;
}

export interface DevEditorConfig {
  getModel: () => string;
  getPrice: () => ModelPriceConfig | undefined;
  getProjectContext: () => ProjectContextPack; // re-read each send; /reload swaps it
  cacheProjectContext: boolean;
}

export function createDevEditor(
  config: DevEditorConfig,
  zen: ZenClient,
  renderer: Renderer,
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
  getFilePaths: () => string[];
  reloadContext: (target?: string) => Promise<ProjectContextPack>; // provided by main.ts; only main reads files
  sessionStore: SessionStore | null;
  sessionProject: string;
  sourceLabel: string;
  contextHash: string; // updated in place by /reload; stamped on new sessions
  initialSessionId?: number;
}

export function runRepl(config: ReplConfig): Promise<void>;
```

The REPL wires `commandContext.onReloadContext` to `reloadContext`: on success
it refreshes the command context's file/token counts and `contextHash`, keeps
the active conversation and session, and logs the new pack size plus the
cache-rewrite consequence.

During an active request, the first Ctrl+C cancels the request and a second
Ctrl+C force-exits if cancellation has not completed.

---

## Configuration Defaults

| Key                            | Default                      |
| ------------------------------ | ---------------------------- |
| `projects`                     | `{}`                         |
| `context.sources`              | `[]`                         |
| `context.extensions`           | `[".md"]`                    |
| `context.max_tokens`           | `180000`                     |
| `context.cache`                | `true`                       |
| `sessions.enabled`             | `true`                       |
| `sessions.path`                | `"./data/sessions.db"`       |
| `models.line_edit.default`     | `deepseek-v4-flash`          |
| `models.developmental.default` | `deepseek-v4-pro`            |
| `models.pricing.updated`       | date prices last verified    |
| `models.pricing.source`        | Zen pricing page URL         |
| `zen.api_key_env`              | `RAGE_ZEN_API_KEY`           |
| `zen.base_url`                 | `https://opencode.ai/zen/v1` |

At startup, when `models.pricing` is present, `main.ts` logs one info line with
the price-data date and source URL so every session states how current the cost
figures are.

---

## System Prompts

Both editors place stable role instructions and the project context pack in the
system prompt. The user message and conversation history remain after that
stable prefix so Zen/provider prompt caching can apply.

### Line Editor

```
You are a line editor reviewing markdown documents. Your job is to provide
feedback on writing at the sentence and paragraph level. You critique clarity,
word choice, rhythm, redundancy, grammar, and precision.

You NEVER rewrite the text. You point out issues and explain why they are
issues. The writer does the writing.

You have no file system access or tools. Work only from the provided project
context. When referencing specific text, cite the file path and line numbers
from context.

Project context:
{projectContext}
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

You have no file system access or tools. Work only from the provided project
context. When referencing specific text, cite the file path and line numbers
from context.

Project context:
{projectContext}
```

---

## Runtime Flow

1. Load config and resolve project context sources.
2. Fetch Zen model catalog and initialize the model registry.
3. Build a deterministic project context pack from configured files.
4. Open the session database when session persistence is enabled.
5. Start the REPL with file-path completions from the context pack and
   optionally restore `--resume <id>`.
6. Each editor request sends the stable system prompt plus conversation history
   and the current user message to Zen.
7. Each successful user/assistant turn is committed to SQLite. Role or model
   changes start a new logical session. Resuming compares the stored context
   hash to the current project context and warns when they differ.

For Claude/Qwen models, Zen requests use `/messages` with cache control on the
system prompt when `context.cache = true`.
