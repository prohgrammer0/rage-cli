# RAGE

**Retrieval Augmented Generation Editor**

A feedback-only writing tool that sits next to your Obsidian vault. It reads your markdown, indexes it locally, and gives you two kinds of critique through a chat interface: line-level and developmental. It never writes a word for you.

---

## How It Works

Local body, cloud brain. Your vault is indexed locally — embeddings and vector search never leave your machine. When you ask for feedback, your query is embedded locally, relevant chunks are retrieved from SQLite, and the query plus context are sent to a cloud model via OpenCode Zen for critique.

**Line editor** — sentence and paragraph-level critique. Clarity, word choice, rhythm, redundancy, grammar, precision.

**Developmental editor** — structural and argumentative critique. Logical flow, argument strength, missing perspectives, thematic coherence.

Neither editor rewrites your text. They tell you what's wrong and why. You do the writing.

## What It Doesn't Do

- Generate prose, rewrites, or suggestions
- Modify your files
- Send your vault to the cloud (embeddings and storage are always local)
- Require an account for indexing

## Stack

Deno, SQLite, Ollama (embeddings only), OpenCode Zen (cloud inference).

## Requirements

- [Deno](https://deno.com/) (latest stable)
- [Ollama](https://ollama.com/) running locally with `nomic-embed-text` pulled
- An [OpenCode Zen](https://opencode.ai/zen) API key

## Setup

**1. Pull the embedding model**

```bash
ollama pull nomic-embed-text
```

**2. Create a `.env` file**

```bash
cp .env.sample .env
# edit .env with your vault path and Zen API key
```

`.env` format (no `export` prefix — Deno's `--env-file` doesn't support it):

```
RAGE_VAULT_PATH=/path/to/your/vault
RAGE_ZEN_API_KEY=your-zen-api-key
```

**3. Index your vault**

```bash
deno task ingest
```

**4. Start editing**

```bash
deno task edit
```

### Running without .env

Pass everything via flags or environment variables directly:

```bash
deno task ingest -- --vault ~/notes
deno task edit -- --vault ~/notes
```

Or inline:

```bash
RAGE_VAULT_PATH=~/notes RAGE_ZEN_API_KEY=sk-... deno task edit
```

### Compiling to a binary

```bash
deno compile \
  --allow-read --allow-write --allow-net --allow-env --allow-ffi \
  --output rage \
  src/main.ts
```

Then run it directly:

```bash
./rage ingest --vault ~/notes
./rage edit --vault ~/notes
```

Note: `--allow-ffi` is required because SQLite is loaded via FFI. The compiled binary includes all Deno source but still needs the system SQLite library at runtime.

## REPL Commands

```
/role line          Switch to line editor
/role dev           Switch to developmental editor
/model              List available models for current role
/model <tag>        Switch model (resets conversation)
/ingest             Re-index the vault
/status             Show current state
/help               List commands
/quit               Exit
```

## @-Mentions

Reference specific files or directories to force them into the model's context, bypassing pure semantic retrieval:

**Single vault:**
```
@drafts/my-essay.md what's wrong with the opening?
@drafts/ review everything in this folder
look at @journal/2026-03-06.md and tell me what's working
```

**Multiple vaults** — prefix with the vault name (the directory basename):
```
@notes/drafts/my-essay.md what's wrong with the opening?
@work/reports/ review everything in this folder
```

- **File** — fetches all indexed chunks for that file
- **Directory** — fetches all chunks for every file under that path
- Paths are relative to the vault root; multi-vault paths are relative to the named vault
- Ghost text completes paths as you type — Tab or → to accept

If a path has no indexed content, you'll get a warning to run `/ingest`.

## Input

- **Enter** — submit
- **Shift+Enter** — new line
- **Backspace** — delete character; at start of line, merges with previous line
- **Ctrl+C** — exit
- **Tab** or **→** — accept ghost completion (for `/commands` and `@paths`)

## Configuration

RAGE loads `config.default.toml` as the base config. Override with `--config <path>` or environment variables:

| Variable | Purpose |
|---|---|
| `RAGE_VAULT_PATH` | Single vault path (backward compatible) |
| `RAGE_VAULT_PATHS` | Comma-separated vault paths for multiple vaults |
| `RAGE_ZEN_API_KEY` | API key for OpenCode Zen |
| `RAGE_DB_PATH` | Override database path (default: `./data/rage.db`) |

CLI flags are also supported:

```
--vault <path>        Vault path (repeat for multiple: --vault /a --vault /b)
--config <path>       TOML config file
--model-line <tag>    Model for line editing
--model-dev <tag>     Model for developmental editing
```

### Multiple vaults

```bash
# Via CLI
deno task edit --vault ~/notes --vault ~/work

# Via environment
RAGE_VAULT_PATHS=~/notes,~/work deno task edit

# Via .env file
RAGE_VAULT_PATHS=/Users/you/notes,/Users/you/work
```

Vault names for @-mention completion are derived from the directory basename.

## Architecture

`ARCHITECTURE.md` defines module interfaces and contracts. Read it before making changes.

## Project Status

Building in public. Prototype.

## License

TBD
