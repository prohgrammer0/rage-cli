import { parse as parseToml } from "@std/toml";
import type { AppConfig, VaultEntry } from "./schema.ts";

export interface CLIOverrides {
  vaultPaths?: string[];
  configPath?: string;
  project?: string;
  modelLine?: string;
  modelDev?: string;
}

/**
 * Recursively merge `override` on top of `base`.
 * Arrays are replaced (not concatenated).
 * Plain objects are merged recursively.
 */
function deepMerge<T extends Record<string, unknown>>(
  base: T,
  override: Partial<T>,
): T {
  const result = { ...base };
  for (const key of Object.keys(override) as (keyof T)[]) {
    const ov = override[key];
    const bv = base[key];
    if (ov === undefined) continue;
    if (
      typeof ov === "object" &&
      ov !== null &&
      !Array.isArray(ov) &&
      typeof bv === "object" &&
      bv !== null &&
      !Array.isArray(bv)
    ) {
      result[key] = deepMerge(
        bv as Record<string, unknown>,
        ov as Record<string, unknown>,
      ) as T[keyof T];
    } else {
      result[key] = ov as T[keyof T];
    }
  }
  return result;
}

function basename(path: string): string {
  return path.replace(/\/$/, "").split("/").at(-1) ?? path;
}

function pathsToVaultEntries(paths: string[]): VaultEntry[] {
  return paths.map((p) => ({ path: p.trim(), name: basename(p.trim()) }));
}

function selectProject(config: AppConfig, projectName: string): AppConfig {
  const profile = config.projects?.[projectName];
  if (!profile) {
    const available = Object.keys(config.projects ?? {}).sort();
    const suffix = available.length > 0
      ? ` Available projects: ${available.join(", ")}.`
      : ` No projects are configured.`;
    throw new Error(`Project "${projectName}" is not configured.${suffix}`);
  }

  return {
    ...config,
    selected_project: projectName,
    vaults: [],
    context: {
      ...config.context,
      sources: profile.sources ?? [],
    },
  };
}

/**
 * Load and merge configuration.
 *
 * Merge order (later overrides earlier):
 *   1. config.default.toml (bundled alongside this module)
 *   2. User --config <path> file, if provided
 *   3. CLI overrides (vault paths, model tags)
 *   4. Environment variables
 *
 * Context source configuration:
 *   --project <name> / RAGE_PROJECT selects [projects.<name>] sources only
 *   [[context.sources]] entries in config file
 *   [[vaults]] entries in config file (backward-compatible directory shorthand)
 *   --vault <path> flags (each becomes a VaultEntry, name = basename)
 *   RAGE_VAULT_PATHS=path1,path2  (comma-separated; names = basenames)
 *   RAGE_VAULT_PATH=path          (single vault; backward-compatible)
 */
export async function loadConfig(overrides: CLIOverrides): Promise<AppConfig> {
  // 1. Load bundled default config relative to this module.
  const defaultConfigUrl = new URL(
    "../../config.default.toml",
    import.meta.url,
  );
  const defaultToml = await Deno.readTextFile(defaultConfigUrl);
  const defaultConfig = parseToml(defaultToml) as unknown as AppConfig;

  // 2. Load user config if provided.
  let merged: AppConfig = defaultConfig;
  if (overrides.configPath) {
    const userToml = await Deno.readTextFile(overrides.configPath);
    const userConfig = parseToml(userToml) as unknown as Partial<AppConfig>;
    merged = deepMerge(
      defaultConfig as unknown as Record<string, unknown>,
      userConfig as Record<string, unknown>,
    ) as unknown as AppConfig;
  }

  // 3. Apply CLI vault overrides.
  if (overrides.vaultPaths && overrides.vaultPaths.length > 0) {
    merged = { ...merged, vaults: pathsToVaultEntries(overrides.vaultPaths) };
  }

  let selectedProject = overrides.project?.trim() || undefined;

  if (overrides.modelLine) {
    merged = {
      ...merged,
      models: {
        ...merged.models,
        line_edit: { ...merged.models.line_edit, default: overrides.modelLine },
      },
    };
  }
  if (overrides.modelDev) {
    merged = {
      ...merged,
      models: {
        ...merged.models,
        developmental: {
          ...merged.models.developmental,
          default: overrides.modelDev,
        },
      },
    };
  }

  // 4. Apply environment variables.
  const envVaultPaths = Deno.env.get("RAGE_VAULT_PATHS");
  const envVaultPath = Deno.env.get("RAGE_VAULT_PATH");
  if (envVaultPaths) {
    const paths = envVaultPaths.split(",").map((p) => p.trim()).filter(Boolean);
    merged = { ...merged, vaults: pathsToVaultEntries(paths) };
  } else if (envVaultPath) {
    merged = { ...merged, vaults: pathsToVaultEntries([envVaultPath]) };
  }

  const envProject = Deno.env.get("RAGE_PROJECT")?.trim();
  if (envProject) selectedProject = envProject;

  if (selectedProject) {
    merged = selectProject(merged, selectedProject);
  }

  return merged;
}
