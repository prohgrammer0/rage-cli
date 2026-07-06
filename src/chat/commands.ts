import type { EditorRole, Renderer } from "./renderer.ts";
import type { ModelRegistry } from "../config/models.ts";

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
      ctx.renderer.log(
        "info",
        `Switched to ${
          newRole === "line" ? "line editor" : "developmental editor"
        }. Conversation reset.`,
      );
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

    case "/status": {
      const modelRole = ctx.role === "line" ? "line_edit" : "developmental";
      const activeModel = ctx.modelRegistry.resolve(modelRole);

      ctx.renderer.renderStatus({
        role: ctx.role,
        model: activeModel?.tag ?? "(none)",
        sourceLabel: ctx.sourceLabel,
        fileCount: ctx.fileCount,
        contextTokens: ctx.contextTokens,
        sessionId: ctx.getSessionId() ?? undefined,
      });
      return { type: "ok" };
    }

    case "/sessions": {
      ctx.onListSessions();
      return { type: "ok" };
    }

    case "/resume": {
      const id = Number(args[0]);
      if (!Number.isSafeInteger(id) || id <= 0) {
        ctx.renderer.log("error", "Usage: /resume <session-id>");
        return { type: "ok" };
      }
      ctx.onResumeSession(id);
      return { type: "ok" };
    }

    case "/reload": {
      // Optional target: "/reload @path" or "/reload path".
      const target = args[0]?.replace(/^@/, "");
      await ctx.onReloadContext(target || undefined);
      return { type: "ok" };
    }

    case "/help": {
      const lines = [
        "",
        "  /role <line|dev>      Switch editor role (resets conversation)",
        "  /model [<tag>]        Switch model or list available models",
        "  /sessions             List saved sessions for this project",
        "  /resume <id>          Continue a saved session",
        "  /reload [@path]       Re-read project files — or just one — into context",
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
