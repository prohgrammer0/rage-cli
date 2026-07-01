export interface ZenClient {
  /**
   * Fetch available model IDs from the Zen model catalog.
   * Result is cached for the session lifetime.
   */
  fetchCatalog(): Promise<string[]>;

  /**
   * Stream or return a chat response using the endpoint required by the model
   * family.
   */
  chat(params: {
    model: string;
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
    stream: boolean;
    maxTokens?: number;
    cacheSystemPrompt?: boolean;
    signal?: AbortSignal;
    onThinking?: (text: string) => void;
  }): AsyncIterable<string>;
}

type ChatParams = Parameters<ZenClient["chat"]>[0];

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
      if (usesMessagesEndpoint(params.model)) {
        yield* chatMessages(base, apiKey, params);
        return;
      }
      if (params.model.startsWith("gpt-")) {
        yield* chatResponses(base, apiKey, params);
        return;
      }
      if (params.model.startsWith("gemini-")) {
        yield* chatGemini(base, apiKey, params);
        return;
      }

      yield* chatCompletions(base, apiKey, params);
    },
  };
}

async function* chatCompletions(
  base: string,
  apiKey: string,
  params: ChatParams,
): AsyncIterable<string> {
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    signal: params.signal,
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
    throw new Error(`Zen chat failed (${res.status}): ${body}`);
  }

  if (!params.stream) {
    const data = await res.json() as {
      choices: Array<{
        message: {
          content: string;
          reasoning_content?: string;
          reasoning?: string;
        };
      }>;
    };
    const message = data.choices[0]?.message;
    const thinking = message?.reasoning_content ?? message?.reasoning;
    if (thinking) params.onThinking?.(thinking);
    yield message?.content ?? "";
    return;
  }

  yield* readSseText(res, (payload) => {
    if (payload === "[DONE]") return { done: true };

    const obj = JSON.parse(payload) as {
      choices?: Array<{
        delta?: {
          content?: string;
          reasoning_content?: string;
          reasoning?: string;
        };
        finish_reason?: string | null;
      }>;
    };

    const delta = obj.choices?.[0]?.delta;
    const thinking = delta?.reasoning_content ?? delta?.reasoning;
    if (thinking) params.onThinking?.(thinking);
    return {
      text: delta?.content,
      done: obj.choices?.[0]?.finish_reason === "stop",
    };
  });
}

async function* chatMessages(
  base: string,
  apiKey: string,
  params: ChatParams,
): AsyncIterable<string> {
  const system = params.messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
  const messages = params.messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: message.role,
      content: message.content,
    }));
  const isClaude = params.model.startsWith("claude-");

  const res = await fetch(`${base}/messages`, {
    method: "POST",
    signal: params.signal,
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: params.model,
      max_tokens: params.maxTokens ?? (isClaude ? 8192 : 4096),
      stream: params.stream,
      system: systemForMessages(system, params.cacheSystemPrompt === true),
      messages,
      ...(isClaude
        ? {
          thinking: {
            type: "adaptive",
            display: "summarized",
          },
          output_config: {
            effort: "medium",
          },
        }
        : {}),
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Zen messages failed (${res.status}): ${body}`);
  }

  if (!params.stream) {
    const data = await res.json() as {
      content?: Array<{
        type: string;
        text?: string;
        thinking?: string;
      }>;
    };
    for (const block of data.content ?? []) {
      if (block.type === "thinking" && block.thinking) {
        params.onThinking?.(block.thinking);
      }
    }
    yield data.content
      ?.filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("") ?? "";
    return;
  }

  yield* readSseText(res, (payload) => {
    if (payload === "[DONE]") return { done: true };

    const obj = JSON.parse(payload) as {
      type?: string;
      delta?: { type?: string; text?: string; thinking?: string };
    };

    if (obj.type === "message_stop") return { done: true };
    if (
      obj.type === "content_block_delta" &&
      obj.delta?.type === "text_delta"
    ) {
      return { text: obj.delta.text };
    }
    if (
      obj.type === "content_block_delta" &&
      obj.delta?.type === "thinking_delta"
    ) {
      if (obj.delta.thinking) params.onThinking?.(obj.delta.thinking);
      return {};
    }

    return {};
  });
}

async function* chatResponses(
  base: string,
  apiKey: string,
  params: ChatParams,
): AsyncIterable<string> {
  const body: Record<string, unknown> = {
    model: params.model,
    input: params.messages,
    stream: params.stream,
    reasoning: {
      effort: "medium",
      summary: "auto",
    },
  };
  if (params.maxTokens !== undefined) {
    body.max_output_tokens = params.maxTokens;
  }

  const res = await fetch(`${base}/responses`, {
    method: "POST",
    signal: params.signal,
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const responseBody = await res.text();
    throw new Error(`Zen responses failed (${res.status}): ${responseBody}`);
  }

  if (!params.stream) {
    const data = await res.json() as {
      output_text?: string;
      output?: Array<{
        type?: string;
        summary?: Array<{ type?: string; text?: string }>;
        content?: Array<{ type?: string; text?: string }>;
      }>;
    };
    const thinking = data.output
      ?.filter((item) => item.type === "reasoning")
      .flatMap((item) => item.summary ?? [])
      .map((part) => part.text ?? "")
      .join("");
    if (thinking) params.onThinking?.(thinking);
    yield data.output_text ??
      data.output?.flatMap((item) => item.content ?? [])
        .filter((part) => part.type === "output_text")
        .map((part) => part.text ?? "")
        .join("") ??
      "";
    return;
  }

  yield* readSseText(res, (payload) => {
    if (payload === "[DONE]") return { done: true };

    const obj = JSON.parse(payload) as {
      type?: string;
      delta?: string;
    };
    if (obj.type === "response.completed") return { done: true };
    if (obj.type === "response.reasoning_summary_text.delta") {
      if (obj.delta) params.onThinking?.(obj.delta);
      return {};
    }
    if (obj.type === "response.output_text.delta") {
      return { text: obj.delta };
    }
    return {};
  });
}

async function* chatGemini(
  base: string,
  apiKey: string,
  params: ChatParams,
): AsyncIterable<string> {
  const system = params.messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
  const contents = params.messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: message.role === "assistant" ? "model" : "user",
      parts: [{ text: message.content }],
    }));

  const body: Record<string, unknown> = { contents };
  if (system) {
    body.systemInstruction = {
      parts: [{ text: system }],
    };
  }
  body.generationConfig = {
    ...(params.maxTokens === undefined
      ? {}
      : { maxOutputTokens: params.maxTokens }),
    thinkingConfig: {
      includeThoughts: true,
    },
  };

  const method = params.stream ? "streamGenerateContent" : "generateContent";
  const suffix = params.stream ? "?alt=sse" : "";
  const res = await fetch(
    `${base}/models/${encodeURIComponent(params.model)}:${method}${suffix}`,
    {
      method: "POST",
      signal: params.signal,
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify(body),
    },
  );

  if (!res.ok) {
    const responseBody = await res.text();
    throw new Error(`Zen Gemini failed (${res.status}): ${responseBody}`);
  }

  type GeminiResponse = {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string; thought?: boolean }> };
      finishReason?: string;
    }>;
  };

  const extractText = (data: GeminiResponse): string => {
    let text = "";
    for (
      const part
        of data.candidates?.flatMap((candidate) =>
          candidate.content?.parts ?? []
        ) ?? []
    ) {
      if (!part.text) continue;
      if (part.thought) params.onThinking?.(part.text);
      else text += part.text;
    }
    return text;
  };

  if (!params.stream) {
    yield extractText(await res.json() as GeminiResponse);
    return;
  }

  yield* readSseText(res, (payload) => {
    if (payload === "[DONE]") return { done: true };

    const data = JSON.parse(payload) as GeminiResponse;
    return {
      text: extractText(data),
      done: data.candidates?.some((candidate) => candidate.finishReason) ??
        false,
    };
  });
}

function systemForMessages(
  system: string,
  cacheSystemPrompt: boolean,
):
  | string
  | Array<
    { type: "text"; text: string; cache_control?: { type: "ephemeral" } }
  > {
  if (!cacheSystemPrompt || !system) return system;
  return [{
    type: "text",
    text: system,
    cache_control: { type: "ephemeral" },
  }];
}

async function* readSseText(
  res: Response,
  extract: (payload: string) => { text?: string; done?: boolean },
): AsyncIterable<string> {
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
        const result = extract(payload);
        if (result.text) yield result.text;
        if (result.done) return;
      }
    }
  } finally {
    await reader.cancel();
  }
}

function usesMessagesEndpoint(model: string): boolean {
  return model.startsWith("claude-") || model.startsWith("qwen3.");
}
