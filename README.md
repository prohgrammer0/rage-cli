# RAGE

**Project-context writing editor**

A feedback-only writing tool that sits next to your notes. It reads configured
markdown files, folders, or globs and gives you two kinds of critique through a
chat interface: line-level and developmental. It never writes a word for you.

---

## How It Works

RAGE uses full-project context, not RAG. There are no embeddings, chunks,
retrieval queries, vector database, or local inference service. SQLite stores
chat session metadata and messages only; it is never used to index or retrieve
project files.

At startup, RAGE:

1. Resolves one named project profile or the configured global sources.
2. Recursively walks directory and glob sources.
3. Skips hidden files and directories, including `.obsidian`.
4. Filters directory and glob results by `context.extensions`.
5. Sorts paths deterministically.
6. Reads each file, adds its path and line numbers, and combines everything into
   one in-memory project context pack.

The pack is placed in the stable system prompt and sent with every request
through OpenCode Zen. Claude and Qwen requests mark that stable prompt
cacheable. The pack is built once per session, so restart RAGE after changing
project files.

**Line editor** — sentence and paragraph-level critique. Clarity, word choice,
rhythm, redundancy, grammar, precision.

**Developmental editor** — structural and argumentative critique. Logical flow,
argument strength, missing perspectives, thematic coherence.

Neither editor rewrites your text. They tell you what's wrong and why. You do
the writing.

## What It Doesn't Do

- Generate prose, rewrites, or suggestions
- Modify your files
- Index, embed, chunk, or retrieve project files
- Refresh project files while a session is running
- Hide cloud context use: included source files are sent to Zen/provider for
  critique

## Stack

Deno, its built-in SQLite support for session history, and OpenCode Zen for
cloud inference.

## Requirements

- [Deno](https://deno.com/) (latest stable)
- An [OpenCode Zen](https://opencode.ai/zen) API key

## Setup

**1. Create a `.env` file**

Create or edit `.env` with your Zen API key.

`.env` format (no `export` prefix — Deno's `--env-file` doesn't support it):

```
RAGE_ZEN_API_KEY=your-zen-api-key
```

**2. Create a project config**

Use absolute paths. Do not rely on `~` expansion inside config files.

```toml
[context]
extensions = [".md"]
max_tokens = 180000
cache = true

[sessions]
enabled = true
path = "./data/sessions.db"

[projects.blog]
sources = [{ path = "/Users/you/notes/blog", name = "blog" }]

[projects.drafts]
sources = [{ path = "/Users/you/notes/drafts", name = "drafts" }]

[projects.book]
sources = [{ path = "/Users/you/notes/book/**/*.md", name = "book" }]
```

Each profile is a selectable source set. Exact file sources are included
explicitly. Directory and glob sources use `context.extensions` as the file
filter. Selecting a profile loads only that profile; project sources are not
combined unless they are listed together in the same profile.

**3. Start editing**

```bash
deno task edit --config config.toml --project blog
```

For a single folder, the older vault shorthand still works:

```bash
RAGE_VAULT_PATH=/absolute/path/to/your/obsidian/vault
deno task edit
```

### Running Without .env

Pass everything via flags or environment variables directly:

```bash
RAGE_ZEN_API_KEY=sk-... deno task edit --config config.toml --project blog
```

Or use the backward-compatible folder shorthand:

```bash
RAGE_ZEN_API_KEY=sk-... deno task edit --vault "/Users/you/Obsidian Vault"
```

### Compiling to a binary

```bash
deno compile \
  --allow-read --allow-write --allow-net --allow-env \
  --output rage \
  src/main.ts
```

Then run it directly:

```bash
./rage edit --config config.toml --project blog
```

## Models

The default registry contains the Zen models enabled for this project:

- Claude Opus 4.8
- Claude Sonnet 4.6
- GPT 5.5
- GPT 5.5 Pro
- Gemini 3.1 Pro
- Gemini 3.5 Flash
- DeepSeek V4 Flash
- DeepSeek V4 Pro
- GLM 5.2
- Kimi K2.6
- Qwen3.6 Plus
- MiniMax M2.7

DeepSeek V4 Flash is the default line editor. DeepSeek V4 Pro is the default
developmental editor. This pairing keeps routine line critique inexpensive while
reserving the stronger open-weight model for project-level reasoning. RAGE
checks Zen's live model catalog at startup and only offers models available to
the current API key.

When a provider exposes thinking or a reasoning summary, RAGE shows the complete
text in a dimmed block before the answer. Provider bursts are paced into small
terminal writes for smoother rendering. Claude uses adaptive thinking with
summarized display, while GPT and Gemini opt into their summary protocols. Other
models display thinking when Zen emits it. Thinking is not added to conversation
history.

## REPL Commands

```
/role line          Switch to line editor
/role dev           Switch to developmental editor
/model              List available models for current role
/model <tag>        Switch model (resets conversation)
/sessions           List saved sessions for the selected project
/resume <id>        Restore and continue a saved session
/status             Show current state
/help               List commands
/quit               Exit
```

Slash commands show dimmed ghost completion as you type. For example, `/res`
completes to `/resume` and `/se` completes to `/sessions`. Press Tab or → to
accept the suggestion.

## @-Path Completion

All included files are already in project context. You can still type `@path`
references as a precise cue to the model, and the REPL completes paths from the
built project context:

**Named sources:**

```
@personal/essay.md what's wrong with the opening?
@work/reports/ review everything in this folder
look at @research/themes.md and tell me what's working
```

**Vault shorthand** — paths are relative to the vault root for one vault, or
prefixed with the vault name for multiple vaults:

```
@drafts/my-essay.md what's wrong with the opening?
@notes/drafts/my-essay.md compare this against @work/reports/
```

- Named file, directory, and glob sources use the configured `name` prefix
- Ghost text completes paths as you type — Tab or → to accept

## Input

- **Enter** — submit
- **Shift+Enter** — new line
- **Paste** — preserve multiline text as one prompt
- **Backspace** — delete character; at start of line, merges with previous line
- **Ctrl+C** — cancel an active response; press again to force-exit
- **↑** or **↓** — navigate prompts entered during the current session
- **Tab** or **→** — accept ghost completion for slash commands, `/role`
  arguments, and `@paths`

## Configuration

RAGE loads `config.default.toml` as the base config. Override with
`--config <path>` or environment variables:

| Variable               | Purpose                                         |
| ---------------------- | ----------------------------------------------- |
| `RAGE_VAULT_PATH`      | Single vault path (backward compatible)         |
| `RAGE_VAULT_PATHS`     | Comma-separated vault paths for multiple vaults |
| `RAGE_PROJECT`         | Named `[projects.<name>]` source profile        |
| `RAGE_ZEN_API_KEY`     | API key for OpenCode Zen                        |
| `RAGE_SESSION_DB_PATH` | Override the SQLite session database path       |

CLI flags are also supported:

```
--vault <path>        Backward-compatible directory source (repeatable)
--config <path>       TOML config file
--project <name>      Use a named [projects.<name>] source profile
--model-line <tag>    Model for line editing
--model-dev <tag>     Model for developmental editing
--resume <id>         Resume a saved session
```

### Context

The project context pack is controlled by:

```toml
[context]
extensions = [".md"]
max_tokens = 180000
cache = true

[[context.sources]]
path = "/absolute/path/to/file-or-folder-or/**/*.md"
name = "optional-display-prefix"
```

`context.sources` is the main list of project files. A source can be an exact
file, a directory, or a simple `*`/`**` glob. `extensions` controls which files
are included from directories and globs. Exact files are included regardless of
extension. `max_tokens` caps the deterministic project prompt. `cache = true`
marks the stable project block cacheable for Zen models that use the
Anthropic-compatible endpoint.

Token counts use `Math.ceil(text.length / 4)`. Files are considered in sorted
path order. If a file would exceed `context.max_tokens`, it is omitted and RAGE
reports how many files were skipped. This warning is a context-window safeguard,
not retrieval behavior: it means the model did not receive the entire project.
Increase `max_tokens` or narrow the selected project's sources when it appears.

Directory sources include every matching file. If a directory contains a
generated aggregate of its source files, either exclude the aggregate from the
source set or load it alone; including both duplicates context.

### Sessions

Successful user/assistant turns are saved by default:

```toml
[sessions]
enabled = true
path = "./data/sessions.db"
```

Use `/sessions` to list sessions for the selected project and `/resume <id>` to
restore one. A resumed transcript is shown in the terminal and supplied to the
model as conversation history. You can also resume directly at startup:

```bash
deno task edit --config config.toml --project blog --resume 12
```

RAGE stores the project name, source label, editor role, model, context hash,
and user/assistant messages. It does not store project files, the assembled
project context, API keys, provider thinking, embeddings, or retrieval data.
Project context is rebuilt from disk on every launch. If it differs from the
context used when a session was created, RAGE warns and continues with the
current files.

Changing the editor role or model starts a new logical session. Set
`sessions.enabled = false` to disable persistence.

### Project profiles

When you do not use every source set at once, define named profiles:

```toml
[projects.blog]
sources = [{ path = "/absolute/path/to/blog", name = "blog" }]

[projects.book]
sources = [
  { path = "/absolute/path/to/book", name = "book" },
  { path = "/absolute/path/to/shared-style.md", name = "style.md" },
]
```

Then select one for a session:

```bash
deno task edit --config config.toml --project blog
RAGE_PROJECT=book deno task edit --config config.toml
```

Selecting a project profile replaces global `context.sources` and legacy vault
shorthand sources for that run.

### Vault shorthand

```bash
# Via CLI
deno task edit --vault ~/notes --vault ~/work

# Via environment
RAGE_VAULT_PATHS=~/notes,~/work deno task edit

# Via .env file
RAGE_VAULT_PATHS=/Users/you/notes,/Users/you/work
```

Vault names for @-mention completion are derived from the directory basename.

## Development

```bash
deno task test
deno fmt --check
deno lint
deno check src/main.ts
```

## Architecture

`ARCHITECTURE.md` defines module interfaces and contracts. Read it before making
changes.

## Project Status

Building in public. Prototype.

## License

TBD
