import type { ZenClient } from "../providers/zen.ts";
import type { Renderer } from "./renderer.ts";
import type { ProjectContextPack } from "../project/context.ts";
import type { SessionMessage } from "../sessions/store.ts";
import { createThinkingDisplay, renderTextStream } from "./stream.ts";

const DEV_SYSTEM_PROMPT =
  `You are a developmental editor reviewing markdown documents. Your job is to
provide structural and argumentative feedback. You critique logical flow,
argument strength, missing perspectives, structural coherence, thematic
consistency, and whether the piece achieves what it sets out to do.

You NEVER rewrite the text. You identify problems, explain why they matter,
and describe what a solution might look like without writing it. The writer
does the writing.

You have no file system access or tools. Work only from the provided project
context. When referencing specific text, cite the file path and line numbers
from context.

Project context:
{projectContext}`;

export interface DevEditorSession {
  send(
    message: string,
    onStart?: () => void,
    signal?: AbortSignal,
  ): Promise<string | null>;
  resetHistory(): void;
  restoreHistory(messages: SessionMessage[]): void;
}

export interface DevEditorConfig {
  getModel: () => string;
  projectContext: ProjectContextPack;
  cacheProjectContext: boolean;
}

export function createDevEditor(
  config: DevEditorConfig,
  zen: ZenClient,
  renderer: Renderer,
): DevEditorSession {
  type Message = { role: "system" | "user" | "assistant"; content: string };
  let history: Message[] = [];

  return {
    async send(
      message: string,
      onStart?: () => void,
      signal?: AbortSignal,
    ): Promise<string | null> {
      const systemContent = DEV_SYSTEM_PROMPT.replace(
        "{projectContext}",
        config.projectContext.content,
      );

      const messages: Message[] = [
        { role: "system", content: systemContent },
        ...history,
        { role: "user", content: message },
      ];

      let outputStarted = false;
      let spinnerStopped = false;
      const stopSpinner = (): void => {
        if (spinnerStopped) return;
        spinnerStopped = true;
        onStart?.();
      };
      const thinking = createThinkingDisplay({ onStart: stopSpinner });

      try {
        const fullResponse = await renderTextStream(
          zen.chat({
            model: config.getModel(),
            messages,
            stream: true,
            cacheSystemPrompt: config.cacheProjectContext,
            signal,
            onThinking: thinking.append,
          }),
          {
            onStart: async () => {
              await thinking.finish();
              outputStarted = true;
              stopSpinner();
            },
          },
        );

        await thinking.finish();
        stopSpinner();
        Deno.stdout.writeSync(new TextEncoder().encode("\n\n"));
        history.push({ role: "user", content: message });
        history.push({ role: "assistant", content: fullResponse });
        return fullResponse;
      } catch (err) {
        await thinking.finish();
        stopSpinner();
        if (outputStarted) {
          Deno.stdout.writeSync(new TextEncoder().encode("\n"));
        }
        if (signal?.aborted) {
          renderer.log("info", "Canceled.");
          return null;
        }
        renderer.log(
          "error",
          `Developmental editor error: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return null;
      }
    },

    resetHistory(): void {
      history = [];
    },

    restoreHistory(messages: SessionMessage[]): void {
      history = messages.map((message) => ({ ...message }));
    },
  };
}
