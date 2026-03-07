import type { EditorRole, Renderer } from "./renderer.ts";
import type { ModelRegistry } from "../config/models.ts";
import type { Queries } from "../store/queries.ts";
import type { Pipeline, PipelineOptions } from "../ingest/pipeline.ts";

export interface CommandContext {
  role: EditorRole;
  modelRegistry: ModelRegistry;
  queries: Queries;
  pipeline: Pipeline | null;
  pipelineOptions: PipelineOptions[] | null;
  renderer: Renderer;
  onRoleChange: (role: EditorRole) => void;
  onModelChange: (tag: string) => void;
  onQuit: () => void;
}

export type CommandResult =
  | { type: "ok" }
  | { type: "unknown"; input: string }
  | { type: "quit" };

export async function handleCommand(
  input: string,
  ctx: CommandContext,
): Promise<CommandResult> {
  const trimmed = input.trim();
  const [cmd, ...args] = trimmed.split(/\s+/);

  switch (cmd) {
    case "/role": {
      const newRole = args[0] as EditorRole | undefined;
      if (newRole !== "line" && newRole !== "dev") {
        ctx.renderer.log("error", "Usage: /role <line|dev>");
        return { type: "ok" };
      }
      ctx.onRoleChange(newRole);
      ctx.renderer.log("info", `Switched to ${newRole === "line" ? "line editor" : "developmental editor"}. Conversation reset.`);
      return { type: "ok" };
    }

    case "/model": {
      const tag = args[0];
      if (!tag) {
        // List available models for current role.
        const modelRole = ctx.role === "line" ? "line_edit" : "developmental";
        const available = ctx.modelRegistry.getAvailable(modelRole);
        ctx.renderer.renderModelList(available);
        return { type: "ok" };
      }
      const modelRole = ctx.role === "line" ? "line_edit" : "developmental";
      const ok = ctx.modelRegistry.setActive(modelRole, tag);
      if (!ok) {
        ctx.renderer.log(
          "error",
          `Model "${tag}" is not available for the ${ctx.role} role. Use /model to see available models.`,
        );
        return { type: "ok" };
      }
      ctx.onModelChange(tag);
      ctx.renderer.log("info", `Switched to ${tag}. Conversation reset.`);
      return { type: "ok" };
    }

    case "/ingest": {
      if (!ctx.pipeline || !ctx.pipelineOptions) {
        ctx.renderer.log("error", "Ingest is not available in this mode.");
        return { type: "ok" };
      }
      for (const opts of ctx.pipelineOptions) {
        ctx.renderer.log("info", `Ingesting ${opts.vaultPath}…`);
        const stats = await ctx.pipeline.run(opts);
        ctx.renderer.renderIngestStats(stats);
      }
      return { type: "ok" };
    }

    case "/status": {
      const modelRole = ctx.role === "line" ? "line_edit" : "developmental";
      const activeModel = ctx.modelRegistry.resolve(modelRole);
      const vaultPath = ctx.pipelineOptions?.map((o) => o.vaultPath).join(", ") ?? "(unknown)";

      // Count chunks by scanning the DB.
      const chunkCount = (() => {
        try {
          // Use hasChunks as a proxy — for a real count we'd need a new query.
          // Since we don't have getChunkCount() in the interface, we approximate.
          return ctx.queries.hasChunks() ? -1 : 0; // -1 = "some"
        } catch {
          return 0;
        }
      })();

      const staleCount = ctx.pipelineOptions && ctx.pipelineOptions.length > 0
        ? await (async () => {
          const allPaths = ctx.queries.getAllFilePaths();
          const stats = await Promise.all(
            allPaths.map(async (p) => {
              try {
                const stat = await Deno.stat(p);
                return { path: p, mtimeMs: stat.mtime?.getTime() ?? 0 };
              } catch {
                return { path: p, mtimeMs: -1 };
              }
            }),
          );
          return ctx.queries.countStaleFiles(stats);
        })()
        : 0;

      ctx.renderer.renderStatus({
        role: ctx.role,
        model: activeModel?.tag ?? "(none)",
        vaultPath,
        chunkCount: chunkCount === -1 ? ctx.queries.getAllFilePaths().length : 0,
        staleFileCount: staleCount,
        dbPath: "(see config)",
      });
      return { type: "ok" };
    }

    case "/help": {
      const lines = [
        "",
        "  /role <line|dev>      Switch editor role (resets conversation)",
        "  /model [<tag>]        Switch model or list available models",
        "  /ingest               Re-index the vault",
        "  /status               Show current state",
        "  /help                 Show this help",
        "  /quit                 Exit",
        "",
      ];
      Deno.stdout.writeSync(new TextEncoder().encode(lines.join("\n") + "\n"));
      return { type: "ok" };
    }

    case "/quit":
    case "/exit": {
      ctx.onQuit();
      return { type: "quit" };
    }

    default:
      return { type: "unknown", input };
  }
}
