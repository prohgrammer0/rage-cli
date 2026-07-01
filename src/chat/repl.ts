import type { EditorRole, Renderer } from "./renderer.ts";
import type { CommandContext } from "./commands.ts";
import type { LineEditorSession } from "./line.ts";
import type { DevEditorSession } from "./developmental.ts";
import { handleCommand } from "./commands.ts";
import { readMultilineInput } from "./input.ts";
import { PromptHistory } from "./history.ts";
import type { SessionRecord, SessionStore } from "../sessions/store.ts";

export interface ReplConfig {
  initialRole: EditorRole;
  commandContext: CommandContext;
  lineEditor: LineEditorSession;
  devEditor: DevEditorSession;
  renderer: Renderer;
  getFilePaths: () => string[];
  sessionStore: SessionStore | null;
  sessionProject: string;
  sourceLabel: string;
  contextHash: string;
  initialSessionId?: number;
}

export async function runRepl(config: ReplConfig): Promise<void> {
  let role: EditorRole = config.initialRole;
  let quit = false;
  let activeStream: AbortController | null = null;
  let currentSession: SessionRecord | null = null;
  const promptHistory = new PromptHistory();

  const activeModel = (editorRole = role): string => {
    const modelRole = editorRole === "line" ? "line_edit" : "developmental";
    return config.commandContext.modelRegistry.resolve(modelRole)?.tag ?? "?";
  };

  const restoreSession = (id: number): boolean => {
    if (!config.sessionStore) {
      config.renderer.log("error", "Session persistence is disabled.");
      return false;
    }
    const session = config.sessionStore.get(id);
    if (!session) {
      config.renderer.log("error", `Session ${id} was not found.`);
      return false;
    }
    if (session.project !== config.sessionProject) {
      config.renderer.log(
        "error",
        `Session ${id} belongs to project "${session.project}", not "${config.sessionProject}".`,
      );
      return false;
    }

    const modelRole = session.editorRole === "line"
      ? "line_edit"
      : "developmental";
    if (
      !config.commandContext.modelRegistry.setActive(modelRole, session.model)
    ) {
      config.renderer.log(
        "error",
        `Session ${id} uses unavailable model "${session.model}".`,
      );
      return false;
    }

    role = session.editorRole;
    config.commandContext.role = role;
    config.lineEditor.resetHistory();
    config.devEditor.resetHistory();
    if (role === "line") {
      config.lineEditor.restoreHistory(session.messages);
    } else {
      config.devEditor.restoreHistory(session.messages);
    }
    for (const message of session.messages) {
      if (message.role === "user") promptHistory.record(message.content);
    }
    currentSession = session;

    if (session.contextHash !== config.contextHash) {
      config.renderer.log(
        "warn",
        `Project files changed since session ${id} was created; continuing with current context.`,
      );
    }
    config.renderer.renderTranscript(session.messages);
    config.renderer.log(
      "info",
      `Resumed session ${id} (${session.editorRole}, ${session.model}).`,
    );
    return true;
  };

  // Wire up callbacks into the command context.
  config.commandContext.onRoleChange = (newRole: EditorRole) => {
    role = newRole;
    config.lineEditor.resetHistory();
    config.devEditor.resetHistory();
    currentSession = null;
  };

  config.commandContext.onModelChange = (_tag: string) => {
    config.lineEditor.resetHistory();
    config.devEditor.resetHistory();
    currentSession = null;
  };

  config.commandContext.onListSessions = () => {
    if (!config.sessionStore) {
      config.renderer.log("warn", "Session persistence is disabled.");
      return;
    }
    config.renderer.renderSessionList(
      config.sessionStore.list(config.sessionProject),
    );
  };

  config.commandContext.onResumeSession = (id: number) => {
    restoreSession(id);
  };

  config.commandContext.getSessionId = () => currentSession?.id ?? null;

  config.commandContext.onQuit = () => {
    quit = true;
  };

  if (config.initialSessionId !== undefined) {
    restoreSession(config.initialSessionId);
  }

  const enc = new TextEncoder();

  // Ctrl+C during streaming cancels the stream.
  // During input (raw mode without cbreak), Ctrl+C arrives as byte 0x03
  // and is handled inside readMultilineInput — the SIGINT signal is suppressed.
  Deno.addSignalListener("SIGINT", () => {
    if (activeStream) {
      if (activeStream.signal.aborted) Deno.exit(130);
      activeStream.abort();
    } else {
      Deno.exit(0);
    }
  });

  const spinFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

  function startSpinner(): () => void {
    let active = true;
    let visible = false;
    let i = 0;
    let interval: number | undefined;
    const delay = setTimeout(() => {
      if (!active) return;
      visible = true;
      const draw = (): void => {
        Deno.stdout.writeSync(
          enc.encode(`\r${spinFrames[i++ % spinFrames.length]} thinking…`),
        );
      };
      draw();
      interval = setInterval(draw, 100);
    }, 120);

    return () => {
      if (!active) return;
      active = false;
      clearTimeout(delay);
      if (interval !== undefined) clearInterval(interval);
      if (visible) Deno.stdout.writeSync(enc.encode("\r\x1b[K"));
    };
  }

  while (!quit) {
    config.commandContext.role = role;

    const prompt = config.renderer.renderPrompt(
      role,
      getActiveModelTag(config),
    );
    const input = await readMultilineInput({
      filePaths: config.getFilePaths().sort(),
      history: promptHistory,
      prompt,
    });

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
        config.renderer.log(
          "error",
          `Unknown command: ${text}. Type /help for commands.`,
        );
      }
    } else {
      const stopSpinner = startSpinner();
      const streamController = new AbortController();
      activeStream = streamController;
      try {
        let response: string | null;
        if (role === "line") {
          response = await config.lineEditor.send(
            text,
            stopSpinner,
            streamController.signal,
          );
        } else {
          response = await config.devEditor.send(
            text,
            stopSpinner,
            streamController.signal,
          );
        }

        if (response !== null && config.sessionStore) {
          try {
            currentSession ??= config.sessionStore.create({
              project: config.sessionProject,
              sourceLabel: config.sourceLabel,
              editorRole: role,
              model: activeModel(),
              contextHash: config.contextHash,
            });
            config.sessionStore.appendTurn(currentSession.id, text, response);
          } catch (error) {
            config.renderer.log(
              "error",
              `Could not save session: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }
      } catch (err) {
        config.renderer.log(
          "error",
          err instanceof Error ? err.message : String(err),
        );
      } finally {
        activeStream = null;
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
