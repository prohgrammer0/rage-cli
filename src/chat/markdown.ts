const DEFAULT_WIDTH = 80;
const MAX_WIDTH = 100;
// Longest inline span we hold back waiting for a closing ` or **. Past this,
// the span is flushed as-is so a stray marker can't stall the stream.
const MAX_SPAN_HOLDBACK = 160;

const CYAN = "\x1b[36m";
const BOLD = "\x1b[1m";
const BOLD_CYAN = "\x1b[1;36m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

export interface MarkdownStreamOptions {
  useColor?: boolean;
  width?: number;
  marker?: string;
}

export interface MarkdownStream {
  push(chunk: string): string;
  end(): string;
}

type LineKind = "text" | "heading" | "bullet" | "quote" | "code";

export function createMarkdownStream(
  options: MarkdownStreamOptions = {},
): MarkdownStream {
  const useColor = options.useColor ?? Deno.stdout.isTerminal();
  const width = options.width ?? detectWidth();
  const marker = options.marker ?? "";
  const indent = marker.length > 0 ? " ".repeat(marker.length + 1) : "";

  const paint = (code: string, s: string): string =>
    useColor && s.length > 0 ? `${code}${s}${RESET}` : s;

  let firstOutput = true;
  let atLineStart = true;
  let inFence = false;
  let prefixBuf = ""; // unclassified chars at the start of a source line
  let kind: LineKind = "text";
  let base = ""; // ANSI applied to the current line's body text
  let hang = ""; // continuation indent for wrapped lines
  let bodyStartCol = 0; // column where this line's body began (no space/wrap before first token)
  let col = 0;
  let token = ""; // current word, or a held-back inline span
  let swallowLine = false; // fence marker lines produce no output

  function lineIndent(): string {
    if (firstOutput && marker.length > 0) {
      firstOutput = false;
      return `${paint(CYAN, marker)} `;
    }
    firstOutput = false;
    return indent;
  }

  // Styles a completed token: strips inline markers, colors code/bold spans.
  // Re-emits the line's base style after each reset so quote/heading styling
  // survives an embedded span.
  function styleInline(s: string): string {
    if (kind === "heading") return s.replaceAll("**", "").replaceAll("`", "");
    let out = s.replace(
      /`([^`]+)`/g,
      (_m, inner: string) =>
        useColor ? `${RESET}${CYAN}${inner}${RESET}${base}` : inner,
    );
    out = out.replace(
      /\*\*([^*]+(?:\*(?!\*)[^*]*)*)\*\*/g,
      (_m, inner: string) =>
        useColor ? `${RESET}${BOLD}${inner}${RESET}${base}` : inner,
    );
    return out;
  }

  function visibleLength(s: string): number {
    let plain = s.replace(/`([^`]+)`/g, "$1");
    if (kind !== "heading") {
      plain = plain.replace(/\*\*([^*]+(?:\*(?!\*)[^*]*)*)\*\*/g, "$1");
    } else {
      plain = plain.replaceAll("**", "").replaceAll("`", "");
    }
    return plain.length;
  }

  function hasOpenSpan(s: string): boolean {
    const backticks = (s.match(/`/g) ?? []).length;
    if (backticks % 2 === 1) return true;
    const strongs = (s.match(/\*\*/g) ?? []).length;
    return strongs % 2 === 1;
  }

  // Emits the current token with greedy word wrap.
  function flushToken(): string {
    if (token.length === 0) return "";
    const t = token;
    token = "";
    const vlen = visibleLength(t);
    let out = "";
    if (col > bodyStartCol) {
      if (col + 1 + vlen > width) {
        out += `\n${hang}${base}`;
        col = stripAnsi(hang).length;
      } else {
        out += " ";
        col++;
      }
    }
    out += styleInline(t);
    col += vlen;
    return out;
  }

  // Classifies a source line from its prefix and emits the styled line start.
  // Returns the output for the prefix plus any leftover chars routed inline.
  function openLine(prefix: string): string {
    atLineStart = false;
    swallowLine = false;
    kind = "text";
    base = "";

    const lead = prefix.match(/^[ \t]*/)![0];
    const rest = prefix.slice(lead.length);
    const pad = lead.replaceAll("\t", "  ");
    let out = lineIndent();
    let leftover = "";

    if (inFence) {
      if (rest.startsWith("```")) {
        inFence = false;
        swallowLine = true;
        return "";
      }
      kind = "code";
      base = useColor ? DIM : "";
      out += pad + base;
      col = stripAnsi(out).length + rest.length;
      bodyStartCol = col;
      hang = "";
      return out + rest;
    }

    if (rest.startsWith("```")) {
      inFence = true;
      swallowLine = true;
      return "";
    }

    const heading = rest.match(/^#{1,6} /);
    const bullet = rest.match(/^[-*+] /);
    const numbered = rest.match(/^(\d{1,3}[.)]) /);
    const quote = rest.match(/^> ?/);

    if (heading) {
      kind = "heading";
      base = useColor ? BOLD_CYAN : "";
      out += base;
      hang = indent;
      leftover = rest.slice(heading[0].length);
    } else if (bullet) {
      kind = "bullet";
      out += pad + paint(CYAN, "•") + " ";
      hang = indent + pad + "  ";
      leftover = rest.slice(bullet[0].length);
    } else if (numbered) {
      kind = "bullet";
      out += pad + paint(CYAN, numbered[1]) + " ";
      hang = indent + pad + " ".repeat(numbered[1].length + 1);
      leftover = rest.slice(numbered[0].length);
    } else if (quote) {
      kind = "quote";
      base = useColor ? DIM : "";
      out += pad + paint(DIM, "│ ") + base;
      hang = indent + pad + (useColor ? `${DIM}│ ${RESET}` : "│ ");
      leftover = rest.slice(quote[0].length);
    } else {
      out += pad;
      hang = indent + pad;
      leftover = rest;
    }

    col = visibleLineWidth(out);
    bodyStartCol = col;
    let inline = "";
    for (const ch of leftover) inline += feedInline(ch);
    return out + inline;
  }

  // True while the prefix could still become a block marker with more input.
  function prefixUndecided(prefix: string): boolean {
    const rest = prefix.replace(/^[ \t]*/, "");
    if (rest.length === 0) return true;
    if (/^#{1,6}$/.test(rest)) return true;
    if (/^`{1,2}$/.test(rest)) return true;
    if (/^\d{1,3}[.)]?$/.test(rest)) return true;
    if (rest === "-" || rest === "*" || rest === "+" || rest === ">") {
      return true;
    }
    if (/^(-{2,}|\*{2,}|_{1,})$/.test(rest)) return true;
    return false;
  }

  function prefixDecided(prefix: string): boolean {
    const rest = prefix.replace(/^[ \t]*/, "");
    if (rest.startsWith("```")) return true;
    if (/^#{1,6} /.test(rest)) return true;
    if (/^[-*+] /.test(rest)) return true;
    if (/^\d{1,3}[.)] /.test(rest)) return true;
    if (/^> ?$/.test(rest) && rest.length > 0) return true;
    return false;
  }

  function feedInline(ch: string): string {
    if (swallowLine) return ""; // rest of a fence marker line (language tag)
    if (kind === "code") {
      col++;
      return ch;
    }
    if (ch === " " || ch === "\t") {
      if (token.length > 0 && hasOpenSpan(token)) {
        if (token.length < MAX_SPAN_HOLDBACK) {
          token += " ";
          return "";
        }
      }
      return flushToken();
    }
    token += ch;
    return "";
  }

  function closeLine(): string {
    let out = "";
    if (atLineStart) {
      const prefix = prefixBuf;
      prefixBuf = "";
      const rest = prefix.replace(/^[ \t]*/, "");
      if (!inFence && /^(-{3,}|\*{3,}|_{3,})$/.test(rest)) {
        out += lineIndent() +
          paint(DIM, "─".repeat(Math.min(width - indent.length, 40)));
      } else if (prefix.length > 0 || inFence || rest.length > 0) {
        out += openLine(prefix);
        out += flushToken();
      } else {
        out += lineIndent().trimEnd();
      }
    } else {
      out += flushToken();
    }
    if (swallowLine) {
      swallowLine = false;
      atLineStart = true;
      col = 0;
      return out;
    }
    if (useColor && base.length > 0) out += RESET;
    out += "\n";
    atLineStart = true;
    base = "";
    col = 0;
    return out;
  }

  function feed(ch: string): string {
    if (ch === "\r") return "";
    if (ch === "\n") return closeLine();

    if (atLineStart) {
      prefixBuf += ch;
      if (prefixDecided(prefixBuf)) {
        const prefix = prefixBuf;
        prefixBuf = "";
        return openLine(prefix);
      }
      if (prefixUndecided(prefixBuf)) return "";
      const prefix = prefixBuf;
      prefixBuf = "";
      return openLine(prefix);
    }

    return feedInline(ch);
  }

  return {
    push(chunk: string): string {
      if (chunk.length === 0) return "";
      const safe = chunk.replaceAll("\x1b", "");
      let out = "";
      for (const ch of safe) out += feed(ch);
      return out;
    },

    end(): string {
      let out = "";
      if (atLineStart && prefixBuf.length > 0) {
        out += openLine(prefixBuf);
        prefixBuf = "";
      }
      out += flushToken();
      if (useColor && !atLineStart && base.length > 0) out += RESET;
      return out;
    },
  };
}

export function styleMarkdown(
  text: string,
  options: MarkdownStreamOptions = {},
): string {
  const stream = createMarkdownStream(options);
  return stream.push(text) + stream.end();
}

function detectWidth(): number {
  try {
    return Math.min(Deno.consoleSize().columns, MAX_WIDTH);
  } catch {
    return DEFAULT_WIDTH;
  }
}

function stripAnsi(s: string): string {
  // deno-lint-ignore no-control-regex
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

function visibleLineWidth(s: string): number {
  const plain = stripAnsi(s);
  const lastNewline = plain.lastIndexOf("\n");
  return lastNewline === -1 ? plain.length : plain.length - lastNewline - 1;
}
