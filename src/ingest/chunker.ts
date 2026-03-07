export interface ChunkMetadata {
  id: string;
  filePath: string;
  lineStart: number; // 1-indexed
  lineEnd: number; // 1-indexed, inclusive
  content: string;
  contentHash: string; // SHA-256 of content, hex
  frontmatter: Record<string, unknown> | null;
  links: string[];
}

export interface ChunkerConfig {
  chunkSize: number;
  chunkOverlap: number;
}

/** Token approximation: 1 token ≈ 4 characters. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** SHA-256 of a string, returned as a lowercase hex string. */
async function sha256hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Extract all link targets from markdown content. */
function extractLinks(content: string): string[] {
  const links: string[] = [];
  // Markdown links: [text](url)
  const mdLink = /\[([^\]]*)\]\(([^)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = mdLink.exec(content)) !== null) {
    links.push(m[2]);
  }
  // Bare URLs (not already captured as markdown links)
  const bareUrl = /(?<!\()(https?:\/\/[^\s<>)"]+)/g;
  while ((m = bareUrl.exec(content)) !== null) {
    if (!links.includes(m[1])) {
      links.push(m[1]);
    }
  }
  return links;
}

/** Parse YAML frontmatter from markdown content. Returns {frontmatter, body}. */
function parseFrontmatter(
  content: string,
): { frontmatter: Record<string, unknown> | null; body: string; fmLineCount: number } {
  if (!content.startsWith("---")) {
    return { frontmatter: null, body: content, fmLineCount: 0 };
  }

  const end = content.indexOf("\n---", 3);
  if (end === -1) {
    return { frontmatter: null, body: content, fmLineCount: 0 };
  }

  const fmRaw = content.slice(3, end).trim();
  const body = content.slice(end + 4).replace(/^\n/, "");
  const fmLines = content.slice(0, end + 4).split("\n").length;

  try {
    // Simple YAML parser for common frontmatter patterns.
    // Handles: key: value, key: "quoted", nested objects (basic).
    const frontmatter = parseSimpleYaml(fmRaw);
    return { frontmatter, body, fmLineCount: fmLines };
  } catch {
    return { frontmatter: null, body: content, fmLineCount: 0 };
  }
}

/**
 * Minimal YAML parser for Obsidian-style frontmatter.
 * Handles: scalar values, quoted strings, arrays (bracket or block style).
 * Does not handle nested objects or complex types.
 */
function parseSimpleYaml(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = yaml.split("\n");

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) {
      i++;
      continue;
    }

    const key = line.slice(0, colonIdx).trim();
    const rawVal = line.slice(colonIdx + 1).trim();

    if (!key) {
      i++;
      continue;
    }

    if (rawVal === "" || rawVal === "|" || rawVal === ">") {
      // Block scalar or empty — collect continuation lines
      const parts: string[] = [];
      i++;
      while (i < lines.length && (lines[i].startsWith("  ") || lines[i] === "")) {
        parts.push(lines[i].replace(/^  /, ""));
        i++;
      }
      result[key] = parts.join("\n").trim();
    } else if (rawVal.startsWith("[")) {
      // Inline array: [a, b, c]
      const inner = rawVal.slice(1, rawVal.lastIndexOf("]"));
      result[key] = inner.split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""));
      i++;
    } else if (rawVal.startsWith("-")) {
      // Block array item on same line — unusual, treat as scalar
      result[key] = rawVal.slice(1).trim();
      i++;
    } else {
      // Scalar value
      result[key] = rawVal.replace(/^["']|["']$/g, "");
      i++;
    }
  }

  return result;
}

/**
 * Split body into segments, treating fenced code blocks as atomic units.
 * Returns segments with their starting line number (1-indexed, relative to body start).
 */
function splitIntoSegments(
  body: string,
  bodyLineOffset: number,
): Array<{ content: string; lineStart: number; lineEnd: number }> {
  const segments: Array<{ content: string; lineStart: number; lineEnd: number }> = [];
  const lines = body.split("\n");

  let i = 0;
  while (i < lines.length) {
    // Check for fenced code block start.
    const fenceMatch = lines[i].match(/^(`{3,}|~{3,})/);
    if (fenceMatch) {
      const fence = fenceMatch[1];
      const blockStart = i;
      i++;
      // Consume until matching closing fence.
      while (i < lines.length && !lines[i].startsWith(fence)) {
        i++;
      }
      if (i < lines.length) i++; // consume closing fence line

      const blockContent = lines.slice(blockStart, i).join("\n");
      segments.push({
        content: blockContent,
        lineStart: bodyLineOffset + blockStart,
        lineEnd: bodyLineOffset + i - 1,
      });
      // Skip any trailing blank lines after the block
      continue;
    }

    // Collect a paragraph (text until blank line).
    const paraStart = i;
    const paraLines: string[] = [];
    while (i < lines.length && lines[i].trim() !== "") {
      paraLines.push(lines[i]);
      i++;
    }

    if (paraLines.length > 0) {
      segments.push({
        content: paraLines.join("\n"),
        lineStart: bodyLineOffset + paraStart,
        lineEnd: bodyLineOffset + i - 1,
      });
    }

    // Skip blank lines (paragraph separator).
    while (i < lines.length && lines[i].trim() === "") {
      i++;
    }
  }

  return segments;
}

/**
 * Extract a trailing overlap suffix of approximately `overlapTokens` tokens.
 */
function overlapSuffix(text: string, overlapTokens: number): string {
  const targetChars = overlapTokens * 4;
  if (text.length <= targetChars) return text;
  // Try to cut at a newline boundary near the target position.
  const cutPos = text.length - targetChars;
  const newlinePos = text.indexOf("\n", cutPos);
  if (newlinePos !== -1 && newlinePos < text.length - 1) {
    return text.slice(newlinePos + 1);
  }
  return text.slice(cutPos);
}

export async function chunkMarkdown(
  filePath: string,
  content: string,
  config: ChunkerConfig,
): Promise<ChunkMetadata[]> {
  const { frontmatter, body, fmLineCount } = parseFrontmatter(content);
  // Body lines start after frontmatter (1-indexed).
  const bodyLineOffset = fmLineCount;

  const segments = splitIntoSegments(body, bodyLineOffset);
  const chunks: ChunkMetadata[] = [];

  let accumContent = "";
  let accumLineStart = -1;
  let accumLineEnd = -1;

  async function finalizeChunk(): Promise<void> {
    if (!accumContent.trim()) return;

    const chunkContent = accumContent.trim();
    const idSource = `${filePath}:${accumLineStart}:${accumLineEnd}`;
    const [id, contentHash] = await Promise.all([
      sha256hex(idSource),
      sha256hex(chunkContent),
    ]);

    chunks.push({
      id,
      filePath,
      lineStart: accumLineStart,
      lineEnd: accumLineEnd,
      content: chunkContent,
      contentHash,
      frontmatter,
      links: extractLinks(chunkContent),
    });
  }

  for (const seg of segments) {
    const segTokens = estimateTokens(seg.content);
    const accumTokens = estimateTokens(accumContent);

    if (accumContent === "") {
      // Start fresh accumulator.
      accumContent = seg.content;
      accumLineStart = seg.lineStart;
      accumLineEnd = seg.lineEnd;
    } else if (accumTokens + segTokens <= config.chunkSize) {
      // Fits: append to accumulator.
      accumContent += "\n\n" + seg.content;
      accumLineEnd = seg.lineEnd;
    } else {
      // Doesn't fit: finalize current chunk, start new one with overlap.
      await finalizeChunk();
      const overlap = overlapSuffix(accumContent, config.chunkOverlap);
      accumContent = overlap ? overlap + "\n\n" + seg.content : seg.content;
      accumLineStart = seg.lineStart;
      accumLineEnd = seg.lineEnd;
    }
  }

  // Finalize any remaining accumulator.
  await finalizeChunk();

  return chunks;
}
