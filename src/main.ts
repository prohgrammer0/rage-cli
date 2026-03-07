import { parseArgs } from "@std/cli/parse-args";
import { loadConfig } from "./config/loader.ts";
import { createModelRegistry } from "./config/models.ts";
import { openDatabase } from "./store/db.ts";
import { createVectorStore } from "./store/vectors.ts";
import { createQueries } from "./store/queries.ts";
import { createOllamaClient } from "./providers/ollama.ts";
import { createZenClient } from "./providers/zen.ts";
import { createScanner } from "./ingest/scanner.ts";
import { createEmbedder } from "./ingest/embedder.ts";
import { createPipeline } from "./ingest/pipeline.ts";
import { createRetrievalSearch } from "./retrieval/search.ts";
import { createLineEditor } from "./chat/line.ts";
import { createDevEditor } from "./chat/developmental.ts";
import { createRenderer } from "./chat/renderer.ts";
import { runRepl } from "./chat/repl.ts";

type Subcommand = "ingest" | "edit";

function usage(): void {
  console.error(`Usage: rage <ingest|edit> [options]

Subcommands:
  ingest    Index your vault (local only — zero data leaves the machine)
  edit      Start a feedback session (local embedding, cloud inference)

Options:
  --vault <path>        Path to vault (repeat for multiple vaults)
  --config <path>       Path to a TOML config file
  --model-line <tag>    Model for line editing
  --model-dev <tag>     Model for developmental editing
`);
}

async function main(): Promise<void> {
  const rawArgs = parseArgs(Deno.args, {
    string: ["config", "model-line", "model-dev"],
    collect: ["vault"],
    alias: { v: "vault", c: "config" },
    "--": false,
  });

  const [subcommand, ...rest] = rawArgs._;
  void rest;

  if (!subcommand || !["ingest", "edit"].includes(String(subcommand))) {
    usage();
    Deno.exit(1);
  }

  const cmd = String(subcommand) as Subcommand;

  const config = await loadConfig({
    vaultPaths: rawArgs["vault"] as string[],
    configPath: rawArgs["config"],
    modelLine: rawArgs["model-line"],
    modelDev: rawArgs["model-dev"],
  });

  const renderer = createRenderer();
  const errors: string[] = [];

  // --- Shared startup validation ---

  // 1. Vault paths (required for all subcommands).
  if (config.vaults.length === 0) {
    errors.push(
      `No vault configured. Use --vault <path> or set RAGE_VAULT_PATH.`,
    );
  } else {
    for (const vault of config.vaults) {
      try {
        const stat = await Deno.stat(vault.path);
        if (!stat.isDirectory) {
          errors.push(`Vault path "${vault.path}" is not a directory.`);
        }
      } catch {
        errors.push(`Vault path "${vault.path}" does not exist.`);
      }
    }
  }

  // 2. Ollama reachability (used for embeddings in both modes).
  const ollama = createOllamaClient(config.ollama.base_url);
  let ollamaModels: string[] = [];
  let ollamaOk = false;

  try {
    ollamaModels = await ollama.listModels();
    ollamaOk = true;
  } catch {
    errors.push(
      `Cannot reach Ollama at ${config.ollama.base_url} — is it running? Start it with: ollama serve`,
    );
  }

  if (ollamaOk) {
    // 3. Embedding model.
    if (!ollamaModels.includes(config.models.embedding.model)) {
      errors.push(
        `Embedding model "${config.models.embedding.model}" not found. Install it with: ollama pull ${config.models.embedding.model}`,
      );
    }
  }

  // 4. Database — open and migrate.
  const db = openDatabase(config.database.path);
  db.migrate();
  const vectors = createVectorStore(db);
  const queries = createQueries(db, vectors);

  // --- Subcommand-specific validation ---

  if (cmd === "ingest") {
    if (errors.length > 0) {
      for (const e of errors) renderer.log("error", e);
      db.close();
      Deno.exit(1);
    }

    await runIngest(config, queries, vectors, ollama, renderer);
    db.close();
    return;
  }

  // edit mode needs an indexed DB and cloud access.
  if (!queries.hasChunks()) {
    errors.push(`No indexed content. Run "rage ingest --vault <path>" first.`);
  }

  // 5. Zen API key + catalog.
  const apiKey = Deno.env.get(config.zen.api_key_env);
  let zenModels: string[] = [];
  let zenClient: ReturnType<typeof createZenClient> | null = null;

  if (!apiKey) {
    errors.push(
      `${config.zen.api_key_env} environment variable not set. Required for rage edit.`,
    );
  } else {
    zenClient = createZenClient(config.zen.base_url, apiKey);
    try {
      zenModels = await zenClient.fetchCatalog();
    } catch {
      errors.push(
        `Cannot fetch model catalog from Zen. Check your internet connection.`,
      );
    }
  }

  // 6. Model registry.
  const registry = createModelRegistry(config);
  registry.initialize(ollamaModels, zenModels);

  for (const m of registry.getUnavailable()) {
    if (m.provider === "ollama") {
      renderer.log("warn", `Model "${m.tag}" not found locally. Install with: ollama pull ${m.tag}`);
    } else {
      renderer.log("warn", `Cloud model "${m.tag}" not available from Zen catalog.`);
    }
  }

  if (registry.resolve("line_edit") === null) {
    errors.push(
      `No available model for line editing. Check your Zen API key and catalog.`,
    );
  }

  if (registry.resolve("developmental") === null) {
    errors.push(
      `No available model for developmental editing. Check your Zen API key and catalog.`,
    );
  }

  if (errors.length > 0) {
    for (const e of errors) renderer.log("error", e);
    db.close();
    Deno.exit(1);
  }

  // --- Staleness check ---
  const scanner = createScanner(queries);
  let staleCount = 0;
  for (const vault of config.vaults) {
    staleCount += await scanner.stalenessCount(vault.path, config.ingest.extensions);
  }
  if (staleCount > 0) {
    renderer.log(
      "warn",
      `${staleCount} file(s) have changed since last ingestion. Run /ingest for up-to-date results.`,
    );
  }

  // --- Start REPL ---
  const embedder = createEmbedder(ollama, config.models.embedding.model);
  const retrieval = createRetrievalSearch(embedder, queries);

  const lineModel = registry.resolve("line_edit")!;
  const devModel = registry.resolve("developmental")!;

  const lineEditor = createLineEditor(
    {
      model: lineModel.tag,
      contextMaxTokens: 2048,
      topK: config.models.line_edit.top_k,
      vaults: config.vaults,
    },
    retrieval,
    zenClient!,
    renderer,
  );

  const devEditor = createDevEditor(
    {
      model: devModel.tag,
      contextMaxTokens: 4096,
      topK: config.models.developmental.top_k,
      vaults: config.vaults,
    },
    retrieval,
    zenClient!,
    renderer,
  );

  const pipeline = createPipeline(scanner, embedder, queries, vectors);
  const pipelineOptions = config.vaults.map((vault) => ({
    vaultPath: vault.path,
    extensions: config.ingest.extensions,
    chunkSize: config.ingest.chunk_size,
    chunkOverlap: config.ingest.chunk_overlap,
    embeddingModel: config.models.embedding.model,
  }));

  const multiVault = config.vaults.length > 1;

  await runRepl({
    initialRole: "line",
    getFilePaths: () => {
      const allPaths = queries.getAllFilePaths();
      if (!multiVault) {
        const prefix = config.vaults[0]?.path.replace(/\/$/, "") + "/";
        return allPaths.map((p) => p.startsWith(prefix) ? p.slice(prefix.length) : p);
      }
      return allPaths.map((p) => {
        for (const vault of config.vaults) {
          const prefix = vault.path.replace(/\/$/, "") + "/";
          if (p.startsWith(prefix)) return vault.name + "/" + p.slice(prefix.length);
        }
        return p;
      });
    },
    commandContext: {
      role: "line",
      modelRegistry: registry,
      queries,
      pipeline,
      pipelineOptions,
      renderer,
      onRoleChange: () => {},
      onModelChange: () => {},
      onQuit: () => {},
    },
    lineEditor,
    devEditor,
    renderer,
  });

  db.close();
}

async function runIngest(
  config: Awaited<ReturnType<typeof loadConfig>>,
  queries: ReturnType<typeof createQueries>,
  vectors: ReturnType<typeof createVectorStore>,
  ollama: ReturnType<typeof createOllamaClient>,
  renderer: ReturnType<typeof createRenderer>,
): Promise<void> {
  const embedder = createEmbedder(ollama, config.models.embedding.model);
  const scanner = createScanner(queries);
  const pipeline = createPipeline(scanner, embedder, queries, vectors);

  for (const vault of config.vaults) {
    renderer.log("info", `Ingesting vault at ${vault.path}…`);
    const stats = await pipeline.run({
      vaultPath: vault.path,
      extensions: config.ingest.extensions,
      chunkSize: config.ingest.chunk_size,
      chunkOverlap: config.ingest.chunk_overlap,
      embeddingModel: config.models.embedding.model,
    });
    renderer.renderIngestStats(stats);
  }
}

if (import.meta.main) {
  await main();
}
