import type { ZenClient } from "../providers/zen.ts";
import type { Renderer } from "./renderer.ts";
import type { ProjectContextPack } from "../project/context.ts";
import { createThinkingDisplay, renderTextStream } from "./stream.ts";

const LINE_SYSTEM_PROMPT =
  `You are a line editor reviewing markdown documents. Your job is to provide
feedback on writing at the sentence and paragraph level. You critique clarity,
word choice, rhythm, redundancy, grammar, and precision.

You NEVER rewrite the text. You point out issues and explain why they are
issues. The writer does the writing.

You have no file system access or tools. Work only from the provided project
context. When referencing specific text, cite the file path and line numbers
from context.

Project context:
{projectContext}`;

export interface LineEditorSession {
  send(
    message: string,
    onStart?: () => void,
    signal?: AbortSignal,
  ): Promise<void>;
  resetHistory(): void;
}

export interface LineEditorConfig {
  getModel: () => string;
  projectContext: ProjectContextPack;
  cacheProjectContext: boolean;
}

export function createLineEditor(
  config: LineEditorConfig,
  zen: ZenClient,
  renderer: Renderer,
): LineEditorSession {
  type Message = { role: "system" | "user" | "assistant"; content: string };
  let history: Message[] = [];

  return {
    async send(
      message: string,
      onStart?: () => void,
      signal?: AbortSignal,
    ): Promise<void> {
      const systemContent = LINE_SYSTEM_PROMPT.replace(
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
      } catch (err) {
        await thinking.finish();
        stopSpinner();
        if (outputStarted) {
          Deno.stdout.writeSync(new TextEncoder().encode("\n"));
        }
        if (signal?.aborted) {
          renderer.log("info", "Canceled.");
          return;
        }
        renderer.log(
          "error",
          `Line editor error: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return;
      }
    },

    resetHistory(): void {
      history = [];
    },
  };
}
