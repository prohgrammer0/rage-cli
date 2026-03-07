// Pure type definitions. Zero imports from this codebase.

export type ModelRole = "line_edit" | "developmental" | "embedding";

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

export interface DatabaseConfig {
  path: string;
}

export interface IngestConfig {
  chunk_size: number;
  chunk_overlap: number;
  extensions: string[];
}

export interface EmbeddingModelConfig {
  provider: "ollama";
  model: string;
  dimensions: number;
}

export interface RoleModelConfig {
  provider: "ollama" | "zen";
  default: string;
  top_k: number;
}

export interface LocalModelRegistryEntry {
  roles: ModelRole[];
  notes: string;
}

export interface CloudModelRegistryEntry {
  roles: Exclude<ModelRole, "embedding">[];
  notes: string;
}

export interface ModelsConfig {
  embedding: EmbeddingModelConfig;
  line_edit: RoleModelConfig;
  developmental: RoleModelConfig;
  registry: {
    local: Record<string, LocalModelRegistryEntry>;
    cloud: Record<string, CloudModelRegistryEntry>;
  };
}

export interface ZenConfig {
  api_key_env: string;
  base_url: string;
}

export interface OllamaConfig {
  base_url: string;
}

export interface AppConfig {
  vaults: VaultEntry[];
  database: DatabaseConfig;
  ingest: IngestConfig;
  models: ModelsConfig;
  zen: ZenConfig;
  ollama: OllamaConfig;
}
