import type { AppConfig, ModelRole } from "./schema.ts";

export type { ModelRole };
export type ModelProvider = "ollama" | "zen";

export interface ModelEntry {
  tag: string;
  provider: ModelProvider;
  roles: ModelRole[];
  available: boolean;
  notes: string;
}

export interface ModelRegistry {
  /**
   * Build the runtime availability list by cross-referencing config registry
   * entries against actually installed/available models.
   */
  initialize(ollamaModels: string[], zenModels: string[]): void;

  /** Return all available models for a given role. */
  getAvailable(role: ModelRole): ModelEntry[];

  /**
   * Resolve the active model for a role.
   * Priority: setActive override > config default > first available.
   * Returns null if nothing is available.
   */
  resolve(role: ModelRole): ModelEntry | null;

  /**
   * Switch the active model for a role.
   * Returns false if the tag is not available for that role.
   */
  setActive(role: ModelRole, tag: string): boolean;

  /**
   * Return all registry entries that are not available at runtime.
   * Used to emit WARN logs at startup.
   */
  getUnavailable(): ModelEntry[];
}

export function createModelRegistry(config: AppConfig): ModelRegistry {
  const allEntries = new Map<string, ModelEntry>();

  for (const [tag, entry] of Object.entries(config.models.registry.local)) {
    allEntries.set(tag, {
      tag,
      provider: "ollama",
      roles: entry.roles as ModelRole[],
      available: false,
      notes: entry.notes,
    });
  }
  for (const [tag, entry] of Object.entries(config.models.registry.cloud)) {
    allEntries.set(tag, {
      tag,
      provider: "zen",
      roles: entry.roles as ModelRole[],
      available: false,
      notes: entry.notes,
    });
  }

  const activeOverrides = new Map<ModelRole, string>();
  let initialized = false;

  return {
    initialize(ollamaModels: string[], zenModels: string[]): void {
      const ollamaSet = new Set(ollamaModels);
      const zenSet = new Set(zenModels);

      for (const entry of allEntries.values()) {
        entry.available = entry.provider === "ollama"
          ? ollamaSet.has(entry.tag)
          : zenSet.has(entry.tag);
      }

      initialized = true;
    },

    getAvailable(role: ModelRole): ModelEntry[] {
      if (!initialized) return [];
      return Array.from(allEntries.values()).filter(
        (e) => e.available && e.roles.includes(role),
      );
    },

    resolve(role: ModelRole): ModelEntry | null {
      const available = this.getAvailable(role);
      if (available.length === 0) return null;

      const override = activeOverrides.get(role);
      if (override) {
        const found = available.find((e) => e.tag === override);
        if (found) return found;
      }

      let defaultTag: string | undefined;
      if (role === "line_edit") defaultTag = config.models.line_edit.default;
      else if (role === "developmental") defaultTag = config.models.developmental.default;
      else if (role === "embedding") defaultTag = config.models.embedding.model;

      if (defaultTag) {
        const found = available.find((e) => e.tag === defaultTag);
        if (found) return found;
      }

      return available[0];
    },

    setActive(role: ModelRole, tag: string): boolean {
      const found = this.getAvailable(role).find((e) => e.tag === tag);
      if (!found) return false;
      activeOverrides.set(role, tag);
      return true;
    },

    getUnavailable(): ModelEntry[] {
      return Array.from(allEntries.values()).filter((e) => !e.available);
    },
  };
}
