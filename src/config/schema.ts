// Pure type definitions. Zero imports from this codebase.

export type ModelRole = "line_edit" | "developmental";

export interface VaultEntry {
  /** Absolute path to the vault directory. */
  path: string;
  /**
   * Short name used in @-mentions when multiple vaults are configured.
   * E.g. name="work" → user types @work/notes/foo.md
   * Defaults to the basename of path when derived from CLI/env.
   */
  name: string;
}

export interface ProjectSourceEntry {
  /** File, directory, or simple glob path to include in project context. */
  path: string;
  /** Optional display prefix/name used in context paths and @-completion. */
  name?: string;
}

export interface ProjectProfileConfig {
  /** Sources used when this named project profile is selected. */
  sources: ProjectSourceEntry[];
}

export interface ContextConfig {
  sources: ProjectSourceEntry[];
  extensions: string[];
  max_tokens: number;
  cache: boolean;
}

export interface RoleModelConfig {
  provider: "zen";
  default: string;
}

export interface CloudModelRegistryEntry {
  roles: ModelRole[];
  notes: string;
}

export interface ModelsConfig {
  line_edit: RoleModelConfig;
  developmental: RoleModelConfig;
  registry: {
    cloud: Record<string, CloudModelRegistryEntry>;
  };
}

export interface ZenConfig {
  api_key_env: string;
  base_url: string;
}

export interface AppConfig {
  selected_project?: string;
  projects: Record<string, ProjectProfileConfig>;
  vaults: VaultEntry[];
  context: ContextConfig;
  models: ModelsConfig;
  zen: ZenConfig;
}
