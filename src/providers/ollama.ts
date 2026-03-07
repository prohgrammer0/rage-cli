export interface OllamaClient {
  /**
   * GET /api/tags
   * Returns installed model name strings.
   * Throws if Ollama is unreachable.
   */
  listModels(): Promise<string[]>;

  /**
   * POST /api/embeddings
   * Returns a Float32Array of the model's output dimensions.
   */
  embed(text: string, model: string): Promise<Float32Array>;
}

export function createOllamaClient(baseUrl: string): OllamaClient {
  const base = baseUrl.replace(/\/$/, "");

  return {
    async listModels(): Promise<string[]> {
      const res = await fetch(`${base}/api/tags`);
      if (!res.ok) {
        await res.body?.cancel();
        throw new Error(
          `Ollama responded with ${res.status} ${res.statusText}`,
        );
      }
      const data = await res.json() as { models: Array<{ name: string }> };
      return data.models.map((m) => m.name);
    },

    async embed(text: string, model: string): Promise<Float32Array> {
      const res = await fetch(`${base}/api/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, prompt: text }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Ollama embed failed (${res.status}): ${body}`);
      }
      const data = await res.json() as { embedding: number[] };
      return new Float32Array(data.embedding);
    },
  };
}
