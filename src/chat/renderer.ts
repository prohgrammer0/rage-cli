import { bold, cyan, gray, green, red, yellow } from "@std/fmt/colors";
import type { ModelEntry } from "../config/models.ts";
import type { IngestStats } from "../ingest/pipeline.ts";

export type LogLevel = "info" | "warn" | "error" | "debug";
export type EditorRole = "line" | "dev";

export interface StatusState {
  role: EditorRole;
  model: string;
  vaultPath: string;
  chunkCount: number;
  staleFileCount: number;
  dbPath: string;
}

export interface RenderOptions {
  useColor: boolean;
}

export interface Renderer {
  renderPrompt(role: EditorRole, model: string): string;
  log(level: LogLevel, msg: string): void;
  renderModelList(models: ModelEntry[]): void;
  renderStatus(state: StatusState): void;
  renderIngestStats(stats: IngestStats): void;
}

export function createRenderer(options?: Partial<RenderOptions>): Renderer {
  const useColor = options?.useColor ?? Deno.stdout.isTerminal();

  function color(fn: (s: string) => string, s: string): string {
    return useColor ? fn(s) : s;
  }

  const enc = new TextEncoder();

  function print(s: string): void {
    Deno.stdout.writeSync(enc.encode(s));
  }

  function printErr(s: string): void {
    Deno.stderr.writeSync(enc.encode(s));
  }

  return {
    renderPrompt(role: EditorRole, model: string): string {
      const roleLabel = role === "line" ? "line" : "dev";
      const shortModel = model.includes("/")
        ? model.split("/").pop()!
        : model;
      if (useColor) {
        return `${color(cyan, `[${roleLabel} • ${shortModel}]`)} ${color(bold, ">")} `;
      }
      return `[${roleLabel} • ${shortModel}] > `;
    },

    log(level: LogLevel, msg: string): void {
      let prefix: string;
      switch (level) {
        case "debug":
          prefix = color(gray, "[DEBUG]");
          break;
        case "info":
          prefix = color(green, "[INFO]");
          break;
        case "warn":
          prefix = color(yellow, "[WARN]");
          break;
        case "error":
          prefix = color(red, "[ERROR]");
          break;
      }
      printErr(`${prefix} ${msg}\n`);
    },

    renderModelList(models: ModelEntry[]): void {
      if (models.length === 0) {
        print("No models available.\n");
        return;
      }

      const maxTag = Math.max(...models.map((m) => m.tag.length));
      const maxProvider = Math.max(...models.map((m) => m.provider.length));

      for (const m of models) {
        const tag = m.tag.padEnd(maxTag + 2);
        const provider = m.provider.padEnd(maxProvider + 2);
        const status = m.available ? color(green, "✓") : color(red, "✗");
        print(`  ${status} ${tag}${provider}${color(gray, m.notes)}\n`);
      }
    },

    renderStatus(state: StatusState): void {
      const lines = [
        `Role:         ${state.role === "line" ? "line editor" : "developmental editor"}`,
        `Model:        ${state.model}`,
        `Vault:        ${state.vaultPath}`,
        `Database:     ${state.dbPath}`,
        `Chunks:       ${state.chunkCount.toLocaleString()}`,
        `Stale files:  ${state.staleFileCount > 0
          ? color(yellow, `${state.staleFileCount} (run /ingest to update)`)
          : color(green, "0 (up to date)")}`,
      ];
      print("\n" + lines.join("\n") + "\n\n");
    },

    renderIngestStats(stats: IngestStats): void {
      print([
        "",
        `  Files scanned:   ${stats.filesScanned}`,
        `  Files processed: ${stats.filesProcessed}`,
        `  Files skipped:   ${stats.filesSkipped}`,
        `  Files pruned:    ${stats.filesPruned}`,
        `  Chunks created:  ${stats.chunksCreated}`,
        `  Chunks reused:   ${stats.chunksReused}`,
        `  Chunks pruned:   ${stats.chunksPruned}`,
        "",
      ].join("\n") + "\n");
    },
  };
}
