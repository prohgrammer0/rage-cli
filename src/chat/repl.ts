import type { EditorRole, Renderer } from "./renderer.ts";
import type { CommandContext } from "./commands.ts";
import type { LineEditorSession } from "./line.ts";
import type { DevEditorSession } from "./developmental.ts";
import { handleCommand } from "./commands.ts";
import { readMultilineInput } from "./input.ts";

export interface ReplConfig {
  initialRole: EditorRole;
  commandContext: CommandContext;
  lineEditor: LineEditorSession;
  devEditor: DevEditorSession;
  renderer: Renderer;
  getFilePaths: () => string[];
}

export async function runRepl(config: ReplConfig): Promise<void> {
  let role: EditorRole = config.initialRole;
  let quit = false;
  let activeStream: AbortController | null = null;

  // Wire up callbacks into the command context.
  config.commandContext.onRoleChange = (newRole: EditorRole) => {
    role = newRole;
    config.lineEditor.resetHistory();
    config.devEditor.resetHistory();
  };

  config.commandContext.onModelChange = (_tag: string) => {
    config.lineEditor.resetHistory();
    config.devEditor.resetHistory();
  };

  config.commandContext.onQuit = () => {
    quit = true;
  };

  const enc = new TextEncoder();

  // Ctrl+C during streaming cancels the stream.
  // During input (raw mode without cbreak), Ctrl+C arrives as byte 0x03
  // and is handled inside readMultilineInput — the SIGINT signal is suppressed.
  Deno.addSignalListener("SIGINT", () => {
    if (activeStream) {
      activeStream.abort();
      activeStream = null;
      Deno.stdout.writeSync(enc.encode("\n"));
    } else {
      Deno.exit(0);
    }
  });

  const spinFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

  function startSpinner(): () => void {
    let active = true;
    let i = 0;
    const timer = setInterval(() => {
      if (!active) return;
      Deno.stdout.writeSync(enc.encode(`\r${spinFrames[i++ % spinFrames.length]}`));
    }, 80);
    return () => {
      if (!active) return;
      active = false;
      clearInterval(timer);
      Deno.stdout.writeSync(enc.encode("\r\x1b[K")); // erase spinner
    };
  }

  while (!quit) {
    config.commandContext.role = role;

    const prompt = config.renderer.renderPrompt(role, getActiveModelTag(config));
    Deno.stdout.writeSync(enc.encode(prompt));

    const input = await readMultilineInput(config.getFilePaths().sort());

    if (input.type === "abort") {
      quit = true;
      break;
    }

    const text = input.text;
    if (!text) continue;

    if (text.startsWith("/")) {
      const result = await handleCommand(text, config.commandContext);
      if (result.type === "quit") {
        quit = true;
      } else if (result.type === "unknown") {
        config.renderer.log("error", `Unknown command: ${text}. Type /help for commands.`);
      }
    } else {
      const stopSpinner = startSpinner();
      try {
        if (role === "line") {
          await config.lineEditor.send(text, stopSpinner);
        } else {
          await config.devEditor.send(text, stopSpinner);
        }
      } catch (err) {
        config.renderer.log(
          "error",
          err instanceof Error ? err.message : String(err),
        );
      } finally {
        stopSpinner();
      }
    }
  }
}

function getActiveModelTag(config: ReplConfig): string {
  const role = config.commandContext.role;
  const modelRole = role === "line" ? "line_edit" : "developmental";
  return config.commandContext.modelRegistry.resolve(modelRole)?.tag ?? "?";
}
