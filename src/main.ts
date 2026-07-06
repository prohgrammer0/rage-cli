import { parseArgs } from "@std/cli/parse-args";
import { loadConfig } from "./config/loader.ts";
import { createModelRegistry } from "./config/models.ts";
import { createZenClient } from "./providers/zen.ts";
import {
  buildProjectContextPack,
  updateContextPackFile,
} from "./project/context.ts";
import { createLineEditor } from "./chat/line.ts";
import { createDevEditor } from "./chat/developmental.ts";
import { createRenderer } from "./chat/renderer.ts";
import { runRepl } from "./chat/repl.ts";
import { createSessionStore } from "./sessions/store.ts";

function usage(): void {
  console.error(`Usage: rage [edit] [options]

Options:
  --vault <path>        Backward-compatible directory source (repeatable)
  --config <path>       Path to a TOML config file
  --project <name>      Use a named [projects.<name>] source profile
  --model-line <tag>    Model for line editing
  --model-dev <tag>     Model for developmental editing
  --resume <id>         Resume a saved session
`);
}

function isGlobPath(path: string): boolean {
  return path.includes("*") || path.includes("?");
}

function sourceLabel(config: Awaited<ReturnType<typeof loadConfig>>): string {
  const configured = [
    ...config.context.sources.map((source) =>
      source.name ? `${source.name}: ${source.path}` : source.path
    ),
    ...config.vaults.map((vault) => `${vault.name}: ${vault.path}`),
  ];

  const label = configured.join(", ");
  return config.selected_project
    ? `${config.selected_project}: ${label}`
    : label;
}

async function main(): Promise<void> {
  const rawArgs = parseArgs(Deno.args, {
    string: ["config", "project", "model-line", "model-dev", "resume"],
    collect: ["vault"],
    alias: { v: "vault", c: "config" },
    "--": false,
  });

  const [subcommand] = rawArgs._;
  if (subcommand && String(subcommand) !== "edit") {
    usage();
    Deno.exit(1);
  }

  const config = await loadConfig({
    vaultPaths: rawArgs["vault"] as string[],
    configPath: rawArgs["config"],
    project: rawArgs["project"],
    modelLine: rawArgs["model-line"],
    modelDev: rawArgs["model-dev"],
  });

  const renderer = createRenderer();
  const errors: string[] = [];
  const parsedResume = rawArgs["resume"] === undefined
    ? undefined
    : Number(rawArgs["resume"]);
  const resumeSessionId = parsedResume !== undefined &&
      Number.isSafeInteger(parsedResume) &&
      parsedResume > 0
    ? parsedResume
    : undefined;

  if (rawArgs["resume"] !== undefined && resumeSessionId === undefined) {
    errors.push(`--resume must be a positive session ID.`);
  }

  if (config.sessions.enabled && !config.sessions.path.trim()) {
    errors.push(`sessions.path must not be empty when sessions are enabled.`);
  }

  if (resumeSessionId !== undefined && !config.sessions.enabled) {
    errors.push(`--resume requires sessions.enabled = true.`);
  }

  if (
    !Number.isFinite(config.context.max_tokens) ||
    config.context.max_tokens <= 0
  ) {
    errors.push(`context.max_tokens must be a positive number.`);
  }

  if (config.context.sources.length === 0 && config.vaults.length === 0) {
    errors.push(
      `No project sources configured. Add [[context.sources]], use --project <name>, use --vault <path>, or set RAGE_VAULT_PATH.`,
    );
  }

  for (const source of config.context.sources) {
    const path = source.path.trim();
    if (!path) {
      errors.push(`context.sources contains an empty path.`);
      continue;
    }
    if (isGlobPath(path)) continue;

    try {
      const stat = await Deno.stat(path);
      if (!stat.isDirectory && !stat.isFile) {
        errors.push(`Context source "${path}" is not a file or directory.`);
      }
    } catch {
      errors.push(`Context source "${path}" does not exist.`);
    }
  }

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

  const registry = createModelRegistry(config);
  registry.initialize(zenModels);

  for (const model of registry.getUnavailable()) {
    renderer.log(
      "warn",
      `Cloud model "${model.tag}" not available from Zen catalog.`,
    );
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

  const projectContext = errors.length === 0
    ? await buildProjectContextPack({
      sources: config.context.sources,
      vaults: config.vaults,
      extensions: config.context.extensions,
      maxTokens: config.context.max_tokens,
    }).catch((err) => {
      errors.push(
        `Failed to build project context: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    })
    : null;

  if (projectContext && projectContext.files.length === 0) {
    errors.push(
      `No project context could be built from configured source files. Check context.sources, context.extensions, or increase context.max_tokens.`,
    );
  }

  const sessionStore = errors.length === 0 && config.sessions.enabled
    ? await createSessionStore(config.sessions.path).catch((err) => {
      errors.push(
        `Failed to open session database: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    })
    : null;

  if (errors.length > 0) {
    for (const error of errors) renderer.log("error", error);
    Deno.exit(1);
  }

  renderer.log(
    "info",
    `Project context: ${projectContext!.files.length} file(s), about ${
      projectContext!.tokenCount.toLocaleString()
    } tokens.`,
  );
  if (config.models.pricing) {
    renderer.log(
      "info",
      `Model prices last updated ${config.models.pricing.updated} (${config.models.pricing.source}).`,
    );
  }
  if (projectContext!.filesSkipped > 0) {
    renderer.log(
      "warn",
      `${
        projectContext!.filesSkipped
      } file(s) did not fit in context.max_tokens and were skipped.`,
    );
  }

  const lineModel = registry.resolve("line_edit")!;
  const devModel = registry.resolve("developmental")!;

  // /reload swaps this reference; editors read it through the getter on every
  // send. Only main.ts reads project files. With a target, only that file is
  // re-read and spliced into the pack.
  let activeProjectContext = projectContext!;
  const reloadContext = async (target?: string) => {
    activeProjectContext = target
      ? await updateContextPackFile(
        activeProjectContext,
        target,
        config.context.max_tokens,
      )
      : await buildProjectContextPack({
        sources: config.context.sources,
        vaults: config.vaults,
        extensions: config.context.extensions,
        maxTokens: config.context.max_tokens,
      });
    return activeProjectContext;
  };

  const lineEditor = createLineEditor(
    {
      getModel: () => registry.resolve("line_edit")?.tag ?? lineModel.tag,
      getPrice: () => registry.resolve("line_edit")?.price,
      getProjectContext: () => activeProjectContext,
      cacheProjectContext: config.context.cache,
    },
    zenClient!,
    renderer,
  );

  const devEditor = createDevEditor(
    {
      getModel: () => registry.resolve("developmental")?.tag ?? devModel.tag,
      getPrice: () => registry.resolve("developmental")?.price,
      getProjectContext: () => activeProjectContext,
      cacheProjectContext: config.context.cache,
    },
    zenClient!,
    renderer,
  );

  const sources = sourceLabel(config);

  try {
    await runRepl({
      initialRole: "line",
      getFilePaths: () => activeProjectContext.files.map((file) => file.path),
      reloadContext,
      sessionStore,
      sessionProject: config.selected_project ?? sources,
      sourceLabel: sources,
      contextHash: projectContext!.contextHash,
      initialSessionId: resumeSessionId,
      commandContext: {
        role: "line",
        modelRegistry: registry,
        sourceLabel: sources,
        fileCount: projectContext!.files.length,
        contextTokens: projectContext!.tokenCount,
        renderer,
        onRoleChange: () => {},
        onModelChange: () => {},
        onListSessions: () => {},
        onResumeSession: () => {},
        onReloadContext: () => Promise.resolve(),
        getSessionId: () => null,
        onQuit: () => {},
      },
      lineEditor,
      devEditor,
      renderer,
    });
  } finally {
    sessionStore?.close();
  }
}

if (import.meta.main) {
  await main();
}
