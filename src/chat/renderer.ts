import { bold, cyan, gray, green, red, yellow } from "@std/fmt/colors";
import type { ModelEntry } from "../config/models.ts";
import type { SessionMessage, SessionSummary } from "../sessions/store.ts";

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

export interface RenderOptions {
  useColor: boolean;
}

export interface Renderer {
  renderPrompt(role: EditorRole, model: string): string;
  log(level: LogLevel, msg: string): void;
  renderModelList(models: ModelEntry[]): void;
  renderStatus(state: StatusState): void;
  renderSessionList(sessions: SessionSummary[]): void;
  renderTranscript(messages: SessionMessage[]): void;
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
      const shortModel = model.includes("/") ? model.split("/").pop()! : model;
      if (useColor) {
        return `${color(cyan, `[${roleLabel} • ${shortModel}]`)} ${
          color(bold, ">")
        } `;
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
        `Role:         ${
          state.role === "line" ? "line editor" : "developmental editor"
        }`,
        `Model:        ${state.model}`,
        `Sources:      ${state.sourceLabel}`,
        `Files:        ${state.fileCount.toLocaleString()}`,
        `Context:      ${state.contextTokens.toLocaleString()} tokens (approx)`,
        `Session:      ${state.sessionId ?? "(new)"}`,
      ];
      print("\n" + lines.join("\n") + "\n\n");
    },

    renderSessionList(sessions: SessionSummary[]): void {
      if (sessions.length === 0) {
        print("No saved sessions for this project.\n");
        return;
      }

      print("\n");
      for (const session of sessions) {
        const date = session.updatedAt.replace("T", " ").slice(0, 16);
        const preview = session.preview.replace(/\s+/g, " ").trim();
        const clipped = preview.length > 72
          ? `${preview.slice(0, 71)}…`
          : preview;
        print(
          `  ${color(cyan, String(session.id).padStart(4))}  ${date}  ${
            session.editorRole.padEnd(4)
          }  ${session.model}  ${color(gray, clipped)}\n`,
        );
      }
      print("\nUse /resume <id> to continue a session.\n\n");
    },

    renderTranscript(messages: SessionMessage[]): void {
      if (messages.length === 0) return;

      print("\n");
      for (const message of messages) {
        const label = message.role === "user"
          ? color(cyan, "you")
          : color(green, "assistant");
        print(`${label}\n${message.content.trimEnd()}\n\n`);
      }
    },
  };
}
