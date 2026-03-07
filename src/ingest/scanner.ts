import type { Queries } from "../store/queries.ts";

export interface VaultFile {
  path: string;
  mtimeMs: number;
}

export interface ScanResult {
  new: VaultFile[];
  modified: VaultFile[];
  unchanged: VaultFile[];
  deleted: string[];
}

export interface Scanner {
  scan(vaultPath: string, extensions: string[]): Promise<ScanResult>;
  stalenessCount(vaultPath: string, extensions: string[]): Promise<number>;
}

async function walkVault(
  vaultPath: string,
  extensions: string[],
): Promise<VaultFile[]> {
  const extSet = new Set(extensions);
  const files: VaultFile[] = [];

  async function walk(dir: string): Promise<void> {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.name.startsWith(".")) continue; // skip hidden
      const fullPath = `${dir}/${entry.name}`;
      if (entry.isDirectory) {
        await walk(fullPath);
      } else if (entry.isFile) {
        const ext = entry.name.includes(".")
          ? entry.name.slice(entry.name.lastIndexOf("."))
          : "";
        if (!extSet.has(ext)) continue;
        const stat = await Deno.stat(fullPath);
        files.push({ path: fullPath, mtimeMs: stat.mtime?.getTime() ?? 0 });
      }
    }
  }

  await walk(vaultPath);
  return files;
}

export function createScanner(queries: Queries): Scanner {
  return {
    async scan(vaultPath: string, extensions: string[]): Promise<ScanResult> {
      const diskFiles = await walkVault(vaultPath, extensions);
      const diskMap = new Map(diskFiles.map((f) => [f.path, f.mtimeMs]));

      const result: ScanResult = {
        new: [],
        modified: [],
        unchanged: [],
        deleted: [],
      };

      // Categorize files on disk.
      for (const file of diskFiles) {
        const state = queries.getFileState(file.path);
        if (!state) {
          result.new.push(file);
        } else if (state.mtime_ms !== file.mtimeMs) {
          result.modified.push(file);
        } else {
          result.unchanged.push(file);
        }
      }

      // Files in DB but not on disk are deleted.
      for (const dbPath of queries.getAllFilePaths()) {
        if (!diskMap.has(dbPath)) {
          result.deleted.push(dbPath);
        }
      }

      return result;
    },

    async stalenessCount(
      vaultPath: string,
      extensions: string[],
    ): Promise<number> {
      const diskFiles = await walkVault(vaultPath, extensions);
      return queries.countStaleFiles(
        diskFiles.map((f) => ({ path: f.path, mtimeMs: f.mtimeMs })),
      );
    },
  };
}
