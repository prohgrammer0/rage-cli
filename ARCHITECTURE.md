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
└── src/chat/
    ├── history.ts              (no internal imports)
    ├── input.ts                (imports: history.ts)
    ├── renderer.ts             (imports: config/models.ts)
    ├── stream.ts               (no internal imports)
    ├── commands.ts             (imports: renderer.ts, config/models.ts)
    ├── line.ts                 (imports: providers/zen.ts, project/context.ts types, renderer.ts, stream.ts)
    ├── developmental.ts        (imports: providers/zen.ts, project/context.ts types, renderer.ts, stream.ts)
    └── repl.ts                 (imports: renderer.ts, commands.ts, line.ts, developmental.ts, input.ts)
```

**Rules:**

- No RAG, embeddings, vector DB, SQLite, or local chat mode.
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

export interface RoleModelConfig {
  provider: "zen";
  default: string;
}

export interface CloudModelRegistryEntry {
  roles: ModelRole[];
  notes: string;
}

export interface ModelsConfig {
  line_edit: RoleModelConfig;
  developmental: RoleModelConfig;
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
  }): AsyncIterable<string>;
}

export function createZenClient(baseUrl: string, apiKey: string): ZenClient;
```

---

### `src/project/context.ts`

```typescript
export interface ProjectContextFile {
  path: string;
  tokenCount: number;
}

export interface ProjectContextPack {
  content: string;
  tokenCount: number;
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
}

export interface Renderer {
  renderPrompt(role: EditorRole, model: string): string;
  log(level: LogLevel, msg: string): void;
  renderModelList(models: ModelEntry[]): void;
  renderStatus(state: StatusState): void;
}

export function createRenderer(options?: Partial<RenderOptions>): Renderer;
```

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
  onQuit: () => void;
}

export type CommandResult =
  | { type: "ok" }
  | { type: "unknown"; input: string }
  | { type: "quit" };

export function handleCommand(
  input: string,
  ctx: CommandContext,
): CommandResult;
```

Commands:

- `/role <line|dev>`
- `/model [<tag>]`
- `/status`
- `/help`
- `/quit` or `/exit`

---

### `src/chat/line.ts`

```typescript
export interface LineEditorSession {
  send(
    message: string,
    onStart?: () => void,
    signal?: AbortSignal,
  ): Promise<void>;
  resetHistory(): void;
}

export interface LineEditorConfig {
  getModel: () => string;
  projectContext: ProjectContextPack;
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
  ): Promise<void>;
  resetHistory(): void;
}

export interface DevEditorConfig {
  getModel: () => string;
  projectContext: ProjectContextPack;
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
}

export function runRepl(config: ReplConfig): Promise<void>;
```

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
| `models.line_edit.default`     | `gemini-3.5-flash`           |
| `models.developmental.default` | `claude-opus-4-8`            |
| `zen.api_key_env`              | `RAGE_ZEN_API_KEY`           |
| `zen.base_url`                 | `https://opencode.ai/zen/v1` |

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
4. Start the REPL with file-path completions from the context pack.
5. Each editor request sends the stable system prompt plus conversation history
   and the current user message to Zen.

For Claude/Qwen models, Zen requests use `/messages` with cache control on the
system prompt when `context.cache = true`.
