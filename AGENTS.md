# CLAUDE.md — RAGE project notes

Read ARCHITECTURE.md before making any changes. It is the source of truth for
all module interfaces.

## Implementation decisions

**Full project context:** RAGE does not use RAG, embeddings, SQLite, or local
chat. On startup, it walks configured Obsidian vault paths, builds one
deterministic project context pack, and sends that stable context with each
prompt.

**Cloud-only chat:** Both editors (line and developmental) use Zen for
inference. Claude/Qwen models use Zen's `/messages` endpoint with cache control
when enabled.

**Token counting:** `Math.ceil(text.length / 4)` approximation. Good enough for
context budgeting at this scale.

**Project context pack:** See `src/project/context.ts`. It skips hidden
files/directories, includes configured extensions, sorts paths
deterministically, adds line numbers, and counts skipped files that do not fit
the token budget.

**Raw input / Kitty protocol:** Input uses `Deno.stdin.setRaw(true)` with Kitty
keyboard protocol (`\x1b[>1u`) to distinguish Shift+Enter from Enter. Ctrl+C is
handled as both raw `0x03` and Kitty-encoded `\x1b[99;5u`.

**Zen env var name:** `RAGE_ZEN_API_KEY`.

## Running

```bash
deno task test          # run all tests
deno task edit          # start editing session
```

Vault path and API key are read from `.env` via `--env-file`. See
`config.default.toml` for all defaults.

## Test permissions

All tests require: `--allow-read --allow-write --allow-net --allow-env`.

## Module boundaries

No module may import from another module's internals. Import chain: `main.ts` →
`config/` → `providers/` → `project/` → `chat/`
