import type { OllamaClient } from "../providers/ollama.ts";

export interface Embedder {
  embed(text: string): Promise<Float32Array>;
}

export function createEmbedder(client: OllamaClient, model: string): Embedder {
  return {
    embed(text: string): Promise<Float32Array> {
      return client.embed(text, model);
    },
  };
}
