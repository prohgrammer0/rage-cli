const encoder = new TextEncoder();

export interface StreamTextOptions {
  onStart?: () => void | Promise<void>;
  write?: (text: string) => void;
  flushIntervalMs?: number;
  flushAtChars?: number;
}

export interface ThinkingDisplayOptions {
  onStart?: () => void;
  write?: (text: string) => void;
  frameIntervalMs?: number;
  useColor?: boolean;
}

export interface ThinkingDisplay {
  append(text: string): void;
  finish(): Promise<void>;
}

export function createThinkingDisplay(
  options: ThinkingDisplayOptions = {},
): ThinkingDisplay {
  const write = options.write ??
    ((text: string) => Deno.stdout.writeSync(encoder.encode(text)));
  const frameIntervalMs = options.frameIntervalMs ?? 16;
  const useColor = options.useColor ?? Deno.stdout.isTerminal();

  let started = false;
  let finishRequested = false;
  let trailerWritten = false;
  let queue = "";
  let endsWithNewline = false;
  let draining: Promise<void> | null = null;

  const drain = async (): Promise<void> => {
    while (!finishRequested || queue.length > 0) {
      if (queue.length === 0) {
        await delay(frameIntervalMs);
        continue;
      }

      const targetFrames = finishRequested ? 10 : 6;
      const count = Math.min(
        96,
        Math.max(4, Math.ceil(queue.length / targetFrames)),
      );
      const end = safeSliceEnd(queue, count);
      write(queue.slice(0, end));
      queue = queue.slice(end);
      await delay(frameIntervalMs);
    }
  };

  return {
    append(text: string): void {
      if (!text || finishRequested) return;
      if (!started) {
        started = true;
        options.onStart?.();
        write(useColor ? "\x1b[2mthinking\n" : "thinking\n");
      }
      const safeText = text.replaceAll("\x1b", "");
      queue += safeText;
      endsWithNewline = safeText.endsWith("\n");
      draining ??= drain();
    },

    async finish(): Promise<void> {
      if (trailerWritten) return;
      finishRequested = true;
      if (!started) return;
      await draining;
      if (trailerWritten) return;
      trailerWritten = true;
      const gap = endsWithNewline ? "\n" : "\n\n";
      write(useColor ? `\x1b[0m${gap}` : gap);
    },
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function safeSliceEnd(text: string, requested: number): number {
  let end = Math.min(requested, text.length);
  const last = text.charCodeAt(end - 1);
  const next = text.charCodeAt(end);
  if (
    last >= 0xd800 && last <= 0xdbff &&
    next >= 0xdc00 && next <= 0xdfff
  ) {
    end++;
  }
  return end;
}

/**
 * Coalesces small model deltas into terminal-sized writes. This avoids making
 * stdout backpressure part of the provider's streaming loop while preserving
 * the complete response for conversation history.
 */
export async function renderTextStream(
  chunks: AsyncIterable<string>,
  options: StreamTextOptions = {},
): Promise<string> {
  const write = options.write ??
    ((text: string) => Deno.stdout.writeSync(encoder.encode(text)));
  const flushIntervalMs = options.flushIntervalMs ?? 16;
  const flushAtChars = options.flushAtChars ?? 96;

  let fullText = "";
  let pending = "";
  let started = false;
  let timer: number | undefined;

  const flush = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (!pending) return;
    const text = pending;
    pending = "";
    write(text);
  };

  const scheduleFlush = (): void => {
    if (timer !== undefined) return;
    timer = setTimeout(flush, flushIntervalMs);
  };

  try {
    for await (const chunk of chunks) {
      if (!chunk) continue;
      if (!started) {
        started = true;
        await options.onStart?.();
      }

      fullText += chunk;
      pending += chunk;

      if (pending.length >= flushAtChars || pending.includes("\n")) {
        flush();
      } else {
        scheduleFlush();
      }
    }
  } finally {
    flush();
  }

  return fullText;
}
