import type { ProjectSourceEntry, VaultEntry } from "../config/schema.ts";

export interface ProjectContextFile {
  path: string;
  absolutePath: string;
  block: string;
  tokenCount: number;
}

export interface ProjectContextPack {
  content: string;
  tokenCount: number;
  contextHash: string;
  files: ProjectContextFile[];
  filesSkipped: number;
}

export interface ProjectContextOptions {
  sources: ProjectSourceEntry[];
  vaults: VaultEntry[];
  extensions: string[];
  maxTokens: number;
}

interface DiskFile {
  absolutePath: string;
  displayPath: string;
}

export async function buildProjectContextPack(
  options: ProjectContextOptions,
): Promise<ProjectContextPack> {
  const files = await collectFiles(options);
  files.sort((a, b) =>
    a.displayPath === b.displayPath ? 0 : a.displayPath < b.displayPath ? -1 : 1
  );

  let tokenCount = estimateTokens(PACK_HEADER + PACK_FOOTER);
  let filesSkipped = 0;
  const included: ProjectContextFile[] = [];

  for (const file of files) {
    const raw = await Deno.readTextFile(file.absolutePath);
    const block = formatFileBlock(file.displayPath, raw);
    const blockTokens = estimateTokens(block);

    if (tokenCount + blockTokens > options.maxTokens) {
      filesSkipped++;
      continue;
    }

    tokenCount += blockTokens;
    included.push({
      path: file.displayPath,
      absolutePath: file.absolutePath,
      block,
      tokenCount: blockTokens,
    });
  }

  return { ...await assemblePack(included), filesSkipped };
}

const PACK_HEADER = [
  "<project_context>",
  "The files below are the user's project knowledge. File paths and line numbers are authoritative for citations.",
  "",
].join("\n");
const PACK_FOOTER = "\n</project_context>";

async function assemblePack(
  included: ProjectContextFile[],
): Promise<Omit<ProjectContextPack, "filesSkipped">> {
  const content = included.length === 0
    ? ""
    : PACK_HEADER + included.map((file) => file.block).join("") + PACK_FOOTER;

  return {
    content,
    tokenCount: estimateTokens(content),
    contextHash: await hashText(content),
    files: included,
  };
}

/**
 * Re-reads one already-included file and splices its fresh block into a new
 * pack. Other files keep their in-pack content, so a later full rebuild of the
 * same disk state produces the same contextHash. Throws — leaving the caller's
 * pack untouched — when the path is not in the pack, the file cannot be read,
 * or the updated pack would exceed maxTokens.
 */
export async function updateContextPackFile(
  pack: ProjectContextPack,
  displayPath: string,
  maxTokens: number,
): Promise<ProjectContextPack> {
  const index = pack.files.findIndex((file) => file.path === displayPath);
  if (index === -1) {
    throw new Error(
      `"${displayPath}" is not in the current project context. Use an @path from this project or run /reload for a full rebuild.`,
    );
  }

  const current = pack.files[index];
  const raw = await Deno.readTextFile(current.absolutePath);
  const block = formatFileBlock(current.path, raw);
  const files = pack.files.with(index, {
    ...current,
    block,
    tokenCount: estimateTokens(block),
  });

  const updated = await assemblePack(files);
  if (updated.tokenCount > maxTokens) {
    throw new Error(
      `Reloading "${displayPath}" would grow the context to about ${updated.tokenCount.toLocaleString()} tokens, over the context.max_tokens budget of ${maxTokens.toLocaleString()}. Raise the budget or run /reload for a full rebuild.`,
    );
  }

  return { ...updated, filesSkipped: pack.filesSkipped };
}

async function collectFiles(
  options: ProjectContextOptions,
): Promise<DiskFile[]> {
  const extSet = new Set(options.extensions);
  const files: DiskFile[] = [];

  for (const source of options.sources) {
    files.push(...await expandSource(source, extSet));
  }

  const multiVault = options.vaults.length > 1;
  for (const vault of options.vaults) {
    const root = trimTrailingSlash(normalizePath(vault.path));
    const prefix = multiVault ? vault.name : null;
    files.push(...await collectDirectory(root, prefix, extSet));
  }

  return dedupeFiles(files);
}

async function expandSource(
  source: ProjectSourceEntry,
  extSet: Set<string>,
): Promise<DiskFile[]> {
  const sourcePath = normalizePath(source.path.trim());
  if (!sourcePath) {
    throw new Error("Context source path cannot be empty.");
  }

  if (containsGlob(sourcePath)) {
    return await collectGlob(source, sourcePath, extSet);
  }

  const stat = await Deno.stat(sourcePath);
  if (stat.isFile) {
    return [{
      absolutePath: sourcePath,
      displayPath: explicitFileDisplayPath(source, sourcePath),
    }];
  }

  if (stat.isDirectory) {
    const root = trimTrailingSlash(sourcePath);
    const prefix = sourceDisplayPrefix(source.name, root);
    return await collectDirectory(root, prefix, extSet);
  }

  throw new Error(
    `Context source "${source.path}" is neither a file nor a directory.`,
  );
}

async function collectGlob(
  source: ProjectSourceEntry,
  pattern: string,
  extSet: Set<string>,
): Promise<DiskFile[]> {
  const root = trimTrailingSlash(globRoot(pattern));
  const prefix = sourceDisplayPrefix(source.name, root);
  const regex = globToRegex(pattern);
  const files: DiskFile[] = [];

  await walk(root, (absolutePath) => {
    const normalizedPath = normalizePath(absolutePath);
    if (!regex.test(normalizedPath)) return;
    files.push({
      absolutePath: normalizedPath,
      displayPath: displayWithPrefix(
        prefix,
        relativePath(root, normalizedPath),
      ),
    });
  }, extSet);

  return files;
}

async function collectDirectory(
  root: string,
  displayPrefix: string | null,
  extSet: Set<string>,
): Promise<DiskFile[]> {
  const files: DiskFile[] = [];

  await walk(root, (absolutePath) => {
    const normalizedPath = normalizePath(absolutePath);
    files.push({
      absolutePath: normalizedPath,
      displayPath: displayWithPrefix(
        displayPrefix,
        relativePath(root, normalizedPath),
      ),
    });
  }, extSet);

  return files;
}

async function walk(
  dir: string,
  onFile: (path: string) => void,
  extSet: Set<string>,
): Promise<void> {
  for await (const entry of Deno.readDir(dir)) {
    if (entry.name.startsWith(".")) continue;

    const fullPath = joinPath(dir, entry.name);
    if (entry.isDirectory) {
      await walk(fullPath, onFile, extSet);
    } else if (entry.isFile && extSet.has(extensionOf(entry.name))) {
      onFile(fullPath);
    }
  }
}

function dedupeFiles(files: DiskFile[]): DiskFile[] {
  const seen = new Set<string>();
  const deduped: DiskFile[] = [];

  for (const file of files) {
    const key = normalizePath(file.absolutePath);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(file);
  }

  return deduped;
}

function containsGlob(path: string): boolean {
  return path.includes("*") || path.includes("?");
}

function globRoot(pattern: string): string {
  const firstGlob = firstGlobIndex(pattern);
  const beforeGlob = firstGlob === -1 ? pattern : pattern.slice(0, firstGlob);
  const slash = beforeGlob.lastIndexOf("/");

  if (slash === -1) return ".";
  if (slash === 0) return "/";
  return beforeGlob.slice(0, slash) || ".";
}

function firstGlobIndex(pattern: string): number {
  const star = pattern.indexOf("*");
  const question = pattern.indexOf("?");
  if (star === -1) return question;
  if (question === -1) return star;
  return Math.min(star, question);
}

function globToRegex(pattern: string): RegExp {
  let source = "^";

  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];

    if (char === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          source += "(?:.*/)?";
          i += 2;
        } else {
          source += ".*";
          i += 1;
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += escapeRegexChar(char);
    }
  }

  return new RegExp(`${source}$`);
}

function explicitFileDisplayPath(
  source: ProjectSourceEntry,
  sourcePath: string,
): string {
  const name = source.name?.trim();
  if (name) return trimTrailingSlash(name);

  const fileName = basename(sourcePath);
  const parentName = basename(dirname(sourcePath));
  return parentName && parentName !== "."
    ? `${parentName}/${fileName}`
    : fileName;
}

function sourceDisplayPrefix(
  name: string | undefined,
  root: string,
): string | null {
  const trimmedName = name?.trim();
  if (trimmedName) return trimTrailingSlash(trimmedName);

  const base = basename(root);
  return base && base !== "." ? base : null;
}

function displayWithPrefix(prefix: string | null, relative: string): string {
  return prefix ? `${prefix}/${relative}` : relative;
}

function relativePath(root: string, path: string): string {
  const normalizedRoot = trimTrailingSlash(normalizePath(root));
  const normalizedPath = normalizePath(path);

  if (normalizedRoot === ".") return normalizedPath;
  if (normalizedPath === normalizedRoot) return basename(normalizedPath);
  if (normalizedPath.startsWith(`${normalizedRoot}/`)) {
    return normalizedPath.slice(normalizedRoot.length + 1);
  }
  return normalizedPath;
}

function joinPath(base: string, name: string): string {
  if (base === "." || base === "") return name;
  if (base === "/") return `/${name}`;
  return `${trimTrailingSlash(base)}/${name}`;
}

function dirname(path: string): string {
  const trimmed = trimTrailingSlash(normalizePath(path));
  if (trimmed === "/") return "/";

  const slash = trimmed.lastIndexOf("/");
  if (slash === -1) return ".";
  if (slash === 0) return "/";
  return trimmed.slice(0, slash);
}

function basename(path: string): string {
  const trimmed = trimTrailingSlash(normalizePath(path));
  if (trimmed === "/") return "";

  const slash = trimmed.lastIndexOf("/");
  return slash === -1 ? trimmed : trimmed.slice(slash + 1);
}

function trimTrailingSlash(path: string): string {
  let trimmed = path;
  while (trimmed.length > 1 && trimmed.endsWith("/")) {
    trimmed = trimmed.slice(0, -1);
  }
  return trimmed;
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/");
}

function escapeRegexChar(char: string): string {
  return /[\\^$+?.()|{}[\]]/.test(char) ? `\\${char}` : char;
}

function extensionOf(name: string): string {
  const idx = name.lastIndexOf(".");
  return idx === -1 ? "" : name.slice(idx);
}

function formatFileBlock(path: string, content: string): string {
  const numbered = content.split(/\r?\n/).map((line, index) => {
    return `${index + 1}: ${line}`;
  }).join("\n");

  return [
    `<file path="${escapeAttribute(path)}">`,
    numbered,
    "</file>",
    "",
  ].join("\n");
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}

async function hashText(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
