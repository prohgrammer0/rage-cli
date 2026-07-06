import type { PromptHistory } from "./history.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

// Pre-allocated echo buffers — zero allocation in the per-keystroke hot path.
const CRLF = new Uint8Array([0x0d, 0x0a]);
const BACKSPACE_ECHO = new Uint8Array([0x08, 0x20, 0x08]); // BS SP BS
const CTRLC_ECHO = enc.encode("^C\r\n");
const DISABLE_KITTY = enc.encode("\x1b[<u");
const ENABLE_KITTY = enc.encode("\x1b[>1u");
const DISABLE_BRACKETED_PASTE = enc.encode("\x1b[?2004l");
const ENABLE_BRACKETED_PASTE = enc.encode("\x1b[?2004h");

const COMMANDS = [
  "/exit",
  "/help",
  "/model",
  "/quit",
  "/role",
  "/status",
  "/resume",
  "/reload",
  "/sessions",
];

const ROLE_ARGS = ["dev", "line"];

/**
 * Returns the ghost suffix to display for the current cursor position, or "" if none.
 *
 * @-path completion works on the last line of multi-line input.
 * /command completion only works on single-line input.
 */
export function getGhost(lines: string[], filePaths: string[]): string {
  const lastLine = lines[lines.length - 1];

  // @-path completion: complete the partial path after the last "@" on the current line.
  const atIdx = lastLine.lastIndexOf("@");
  if (atIdx !== -1) {
    const partial = lastLine.slice(atIdx + 1);
    // Don't complete if there's a space after @ (end of the mention).
    if (!partial.includes(" ")) {
      for (const path of filePaths) {
        if (path.startsWith(partial) && path.length > partial.length) {
          return path.slice(partial.length);
        }
      }
      return "";
    }
  }

  // /command completion: only on single-line input.
  if (lines.length !== 1) return "";
  const line = lines[0];
  if (!line.startsWith("/")) return "";

  if (line.startsWith("/role ")) {
    const arg = line.slice(6);
    for (const opt of ROLE_ARGS) {
      if (opt.startsWith(arg) && opt.length > arg.length) {
        return opt.slice(arg.length);
      }
    }
    return "";
  }

  if (!line.includes(" ")) {
    for (const cmd of COMMANDS) {
      if (cmd.startsWith(line) && cmd.length > line.length) {
        return cmd.slice(line.length);
      }
    }
  }

  return "";
}

export type InputResult =
  | { type: "submit"; text: string }
  | { type: "abort" };

export interface InputOptions {
  filePaths?: string[];
  history?: PromptHistory;
  prompt?: string;
}

/**
 * Reads multi-line input from stdin in raw mode.
 *
 * - Printable characters are echoed and accumulated.
 * - Enter (CR) submits.
 * - Shift+Enter inserts a newline (via Kitty keyboard protocol).
 * - Backspace deletes the last character; if the line is empty, merges with the previous line.
 * - Ctrl+C returns { type: "abort" }.
 * - Tab / → accepts the ghost completion when one is shown.
 *
 * Ghost completions appear for / commands and /role arguments.
 */
export async function readMultilineInput(
  options: InputOptions = {},
): Promise<InputResult> {
  const filePaths = options.filePaths ?? [];
  const promptWidth = visibleWidth(options.prompt ?? "");
  options.history?.begin();

  if (options.prompt) {
    Deno.stdout.writeSync(enc.encode(options.prompt));
  }
  Deno.stdin.setRaw(true);
  Deno.stdout.writeSync(ENABLE_KITTY);
  Deno.stdout.writeSync(ENABLE_BRACKETED_PASTE);

  const lines: string[] = [""];
  const raw = new Uint8Array(256);
  let escBuf = "";
  let ghost = ""; // suffix currently displayed in dim after the cursor
  let pasteMode = false;

  // Erase the ghost text currently shown (cursor stays at current position).
  function clearGhost(): void {
    if (ghost.length === 0) return;
    Deno.stdout.writeSync(enc.encode("\x1b[0K")); // erase from cursor to EOL
    ghost = "";
  }

  // Recompute and display ghost based on current buffer state.
  function showGhost(): void {
    const g = getGhost(lines, filePaths);
    if (g.length === 0) {
      ghost = "";
      return;
    }
    // Write dim ghost text, then move cursor back to where it was.
    Deno.stdout.writeSync(enc.encode(`\x1b[2m${g}\x1b[0m\x1b[${g.length}D`));
    ghost = g;
  }

  // Accept the entire ghost: erase dim text, rewrite as normal, advance buffer.
  function acceptGhost(): void {
    if (ghost.length === 0) return;
    const accepted = ghost;
    ghost = "";
    // Cursor is at start of ghost. Erase dim text, write it normally.
    Deno.stdout.writeSync(enc.encode(`\x1b[0K${accepted}`));
    lines[lines.length - 1] += accepted;
    showGhost(); // chain: e.g. accepting "/role" may ghost " line"
  }

  function replaceInput(value: string): void {
    clearGhost();
    const moveToInputStart = lines.length > 1
      ? `\x1b[${lines.length - 1}A\r`
      : "\r";
    const movePastPrompt = promptWidth > 0 ? `\x1b[${promptWidth}C` : "";
    const replacement = value.split("\n");
    lines.splice(0, lines.length, ...replacement);
    Deno.stdout.writeSync(
      enc.encode(
        `${moveToInputStart}${movePastPrompt}\x1b[J${replacement.join("\r\n")}`,
      ),
    );
    showGhost();
  }

  try {
    outer: while (true) {
      const n = await Deno.stdin.read(raw);
      if (n === null) break outer; // EOF

      const bytes = raw.subarray(0, n);

      for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i];

        // Start of an escape sequence.
        if (b === 0x1b) {
          escBuf = "\x1b";
          continue;
        }

        // Accumulating an escape sequence.
        if (escBuf.length > 0) {
          // Ctrl+C mid-escape: abort immediately, don't swallow it.
          if (b === 0x03) {
            escBuf = "";
            clearGhost();
            Deno.stdout.writeSync(CTRLC_ECHO);
            return { type: "abort" };
          }

          escBuf += String.fromCharCode(b);

          // Only handle CSI (ESC [). Anything else: discard.
          if (escBuf.length === 2 && b !== 0x5b) {
            escBuf = "";
            continue;
          }

          // CSI sequence ends with a byte in 0x40–0x7E.
          if (escBuf.length >= 3 && b >= 0x40 && b <= 0x7e) {
            if (escBuf === "\x1b[200~") {
              pasteMode = true;
              clearGhost();
              escBuf = "";
              continue;
            }
            if (escBuf === "\x1b[201~") {
              pasteMode = false;
              escBuf = "";
              showGhost();
              continue;
            }

            // Shift+Enter variants (Kitty / xterm fixterms): insert newline.
            if (escBuf === "\x1b[13;2u" || escBuf === "\x1b[27;2;13~") {
              clearGhost();
              Deno.stdout.writeSync(CRLF);
              lines.push("");
            }
            // Plain Enter in Kitty protocol: submit.
            if (escBuf === "\x1b[13u") {
              clearGhost();
              Deno.stdout.writeSync(CRLF);
              break outer;
            }
            // Ctrl+C in Kitty keyboard protocol (\x1b[99;5u).
            if (escBuf === "\x1b[99;5u") {
              escBuf = "";
              clearGhost();
              Deno.stdout.writeSync(CTRLC_ECHO);
              return { type: "abort" };
            }
            // Right arrow: accept ghost.
            if (escBuf === "\x1b[C") {
              acceptGhost();
            }
            // Up/down arrows: navigate prompt history.
            if (escBuf === "\x1b[A") {
              const previous = options.history?.previous(lines.join("\n"));
              if (previous !== null && previous !== undefined) {
                replaceInput(previous);
              }
            }
            if (escBuf === "\x1b[B") {
              const next = options.history?.next();
              if (next !== null && next !== undefined) replaceInput(next);
            }
            escBuf = "";
          }
          continue;
        }

        // Tab (0x09): accept ghost.
        if (b === 0x09) {
          if (pasteMode) {
            clearGhost();
            lines[lines.length - 1] += "\t";
            Deno.stdout.writeSync(raw.subarray(i, i + 1));
            continue;
          }
          acceptGhost();
          continue;
        }

        // Ctrl+C (ETX).
        if (b === 0x03) {
          clearGhost();
          Deno.stdout.writeSync(CTRLC_ECHO);
          return { type: "abort" };
        }

        // Ctrl+D (EOT): submit.
        if (b === 0x04) {
          clearGhost();
          Deno.stdout.writeSync(CRLF);
          break outer;
        }

        // Enter: CR (0x0D) in raw mode, or LF (0x0A): submit.
        if (b === 0x0d || b === 0x0a) {
          clearGhost();
          if (pasteMode) {
            if (b === 0x0d && bytes[i + 1] === 0x0a) i++;
            Deno.stdout.writeSync(CRLF);
            lines.push("");
            continue;
          }
          Deno.stdout.writeSync(CRLF);
          break outer;
        }

        // Backspace: DEL (0x7F) or BS (0x08).
        if (b === 0x7f || b === 0x08) {
          clearGhost();
          const cur = lines[lines.length - 1];
          if (cur.length > 0) {
            lines[lines.length - 1] = cur.slice(0, -1);
            Deno.stdout.writeSync(BACKSPACE_ECHO);
          } else if (lines.length > 1) {
            // Merge with previous line: move cursor up, to end of that line, clear below.
            lines.pop();
            const prev = lines[lines.length - 1];
            Deno.stdout.writeSync(
              enc.encode(`\x1b[A\x1b[${prev.length + 1}G\x1b[J`),
            );
          }
          showGhost();
          continue;
        }

        // Printable ASCII: echo contiguous runs together. This keeps pasted
        // text and batched terminal input from triggering one write per byte.
        if (b >= 0x20 && b < 0x7f) {
          clearGhost();
          let end = i + 1;
          while (
            end < bytes.length && bytes[end] >= 0x20 && bytes[end] < 0x7f
          ) {
            end++;
          }
          const printable = bytes.subarray(i, end);
          lines[lines.length - 1] += dec.decode(printable);
          Deno.stdout.writeSync(printable);
          i = end - 1;
          showGhost();
          continue;
        }

        // Multi-byte UTF-8.
        if (b >= 0x80) {
          clearGhost();
          let seqLen = 2;
          if (b >= 0xf0) seqLen = 4;
          else if (b >= 0xe0) seqLen = 3;

          const seq = new Uint8Array(seqLen);
          seq[0] = b;
          for (let j = 1; j < seqLen && i + j < bytes.length; j++) {
            seq[j] = bytes[i + j];
          }
          i += seqLen - 1;

          lines[lines.length - 1] += dec.decode(seq);
          Deno.stdout.writeSync(seq);
          showGhost();
        }
      }
    }
  } finally {
    Deno.stdin.setRaw(false);
    Deno.stdout.writeSync(DISABLE_BRACKETED_PASTE);
    Deno.stdout.writeSync(DISABLE_KITTY);
  }

  const text = lines.join("\n").trim();
  options.history?.record(text);
  return { type: "submit", text };
}

function visibleWidth(text: string): number {
  let width = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 0x1b && text[i + 1] === "[") {
      i += 2;
      while (
        i < text.length &&
        (text.charCodeAt(i) < 0x40 || text.charCodeAt(i) > 0x7e)
      ) {
        i++;
      }
      continue;
    }
    width++;
  }
  return width;
}
