export interface ZenClient {
  /**
   * Fetch available model IDs from the models.dev catalog.
   * Extracts the keys of `.opencode.models`.
   * Result is cached for the session lifetime.
   */
  fetchCatalog(): Promise<string[]>;

  /**
   * POST /chat/completions (OpenAI-compatible).
   * Yields content delta strings when streaming.
   */
  chat(params: {
    model: string;
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
    stream: boolean;
  }): AsyncIterable<string>;
}

export function createZenClient(baseUrl: string, apiKey: string): ZenClient {
  const base = baseUrl.replace(/\/$/, "");
  let catalogCache: string[] | null = null;

  return {
    async fetchCatalog(): Promise<string[]> {
      if (catalogCache !== null) return catalogCache;

      const res = await fetch(`${base}/models`);
      if (!res.ok) {
        throw new Error(
          `Failed to fetch model catalog (${res.status}): ${res.statusText}`,
        );
      }

      const data = await res.json() as {
        data?: Array<{ id: string }>;
      };

      if (!data.data) {
        throw new Error("Model catalog missing expected .data field");
      }

      catalogCache = data.data.map((m) => m.id);
      return catalogCache;
    },

    async *chat(params): AsyncIterable<string> {
      const res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: params.model,
          messages: params.messages,
          stream: params.stream,
        }),
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(
          `Zen chat failed (${res.status}): ${body}`,
        );
      }

      if (!params.stream) {
        const data = await res.json() as {
          choices: Array<{ message: { content: string } }>;
        };
        yield data.choices[0]?.message.content ?? "";
        return;
      }

      // SSE stream: each line is "data: <json>" or "data: [DONE]".
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith("data:")) continue;

            const payload = trimmed.slice("data:".length).trim();
            if (payload === "[DONE]") return;

            const obj = JSON.parse(payload) as {
              choices?: Array<{
                delta?: { content?: string };
                finish_reason?: string | null;
              }>;
            };

            const delta = obj.choices?.[0]?.delta?.content;
            if (delta) yield delta;

            if (obj.choices?.[0]?.finish_reason === "stop") return;
          }
        }
      } finally {
        await reader.cancel();
      }
    },
  };
}
