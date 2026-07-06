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

export interface SessionsConfig {
  enabled: boolean;
  path: string;
}

export interface RoleModelConfig {
  provider: "zen";
  default: string;
}

// USD per million tokens. cache_read/cache_write default to the input rate
// when omitted.
export interface ModelPriceConfig {
  input: number;
  output: number;
  cache_read?: number;
  cache_write?: number;
}

export interface CloudModelRegistryEntry {
  roles: ModelRole[];
  notes: string;
  price?: ModelPriceConfig;
}

// Provenance of the registry price data. Logged once at session start so the
// user knows how stale the rates are and where to refresh them from.
export interface PricingMetaConfig {
  updated: string;
  source: string;
}

export interface ModelsConfig {
  line_edit: RoleModelConfig;
  developmental: RoleModelConfig;
  pricing?: PricingMetaConfig;
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
  sessions: SessionsConfig;
  models: ModelsConfig;
  zen: ZenConfig;
}
