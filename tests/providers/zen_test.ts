import { assertEquals, assertRejects } from "@std/assert";
import { createZenClient } from "../../src/providers/zen.ts";

async function withMockServer(
  handler: (req: Request) => Response | Promise<Response>,
  test: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = Deno.serve({ port: 0, onListen: () => {} }, handler);
  const { port } = server.addr as Deno.NetAddr;
  try {
    await test(`http://localhost:${port}`);
  } finally {
    await server.shutdown();
  }
}

// --- fetchCatalog ---

Deno.test("ZenClient - fetchCatalog returns model IDs from /models endpoint", async () => {
  await withMockServer(
    (_req) =>
      Response.json({
        object: "list",
        data: [
          {
            id: "minimax-m2.5",
            object: "model",
            created: 0,
            owned_by: "opencode",
          },
          {
            id: "kimi-k2.5",
            object: "model",
            created: 0,
            owned_by: "opencode",
          },
          { id: "glm-5", object: "model", created: 0, owned_by: "opencode" },
        ],
      }),
    async (base) => {
      const client = createZenClient(base, "test-key");
      const result = await client.fetchCatalog();
      assertEquals(result.sort(), ["glm-5", "kimi-k2.5", "minimax-m2.5"]);
    },
  );
});

// --- chat (non-streaming) ---

Deno.test("ZenClient - chat non-streaming yields full content", async () => {
  await withMockServer(
    async (req) => {
      const body = await req.json();
      assertEquals(body.stream, false);
      assertEquals(req.headers.get("Authorization"), "Bearer test-key");
      return Response.json({
        choices: [{ message: { content: "Good feedback." } }],
      });
    },
    async (base) => {
      const client = createZenClient(base, "test-key");
      const chunks: string[] = [];
      for await (
        const chunk of client.chat({
          model: "minimax-m2.5",
          messages: [{ role: "user", content: "Review this." }],
          stream: false,
        })
      ) {
        chunks.push(chunk);
      }
      assertEquals(chunks, ["Good feedback."]);
    },
  );
});

Deno.test("ZenClient - Claude messages request uses cacheable system block", async () => {
  await withMockServer(
    async (req) => {
      const url = new URL(req.url);
      assertEquals(url.pathname, "/messages");
      assertEquals(req.headers.get("Authorization"), "Bearer test-key");
      assertEquals(req.headers.get("anthropic-version"), "2023-06-01");

      const body = await req.json();
      assertEquals(body.model, "claude-sonnet-4-5");
      assertEquals(body.stream, false);
      assertEquals(body.system[0].cache_control.type, "ephemeral");
      assertEquals(body.system[0].text, "Stable project context");
      assertEquals(body.messages, [{ role: "user", content: "Review this." }]);
      assertEquals(body.max_tokens, 8192);
      assertEquals(body.thinking, {
        type: "adaptive",
        display: "summarized",
      });
      assertEquals(body.output_config, { effort: "medium" });

      return Response.json({
        content: [{ type: "text", text: "Good feedback." }],
      });
    },
    async (base) => {
      const client = createZenClient(base, "test-key");
      const chunks: string[] = [];
      for await (
        const chunk of client.chat({
          model: "claude-sonnet-4-5",
          messages: [
            { role: "system", content: "Stable project context" },
            { role: "user", content: "Review this." },
          ],
          stream: false,
          cacheSystemPrompt: true,
        })
      ) {
        chunks.push(chunk);
      }
      assertEquals(chunks, ["Good feedback."]);
    },
  );
});

Deno.test("ZenClient - Qwen messages omit Claude thinking parameters", async () => {
  await withMockServer(
    async (req) => {
      const body = await req.json();
      assertEquals(body.model, "qwen3.6-plus");
      assertEquals(body.max_tokens, 4096);
      assertEquals(body.thinking, undefined);
      assertEquals(body.output_config, undefined);
      return Response.json({
        content: [{ type: "text", text: "Feedback." }],
      });
    },
    async (base) => {
      const client = createZenClient(base, "test-key");
      const chunks: string[] = [];
      for await (
        const chunk of client.chat({
          model: "qwen3.6-plus",
          messages: [{ role: "user", content: "Review this." }],
          stream: false,
        })
      ) {
        chunks.push(chunk);
      }
      assertEquals(chunks, ["Feedback."]);
    },
  );
});

Deno.test("ZenClient - GPT models use the responses endpoint", async () => {
  await withMockServer(
    async (req) => {
      const url = new URL(req.url);
      assertEquals(url.pathname, "/responses");

      const body = await req.json();
      assertEquals(body.model, "gpt-5.5");
      assertEquals(body.input, [
        { role: "system", content: "Stable project context" },
        { role: "user", content: "Review this." },
      ]);
      assertEquals(body.max_output_tokens, 2048);
      assertEquals(body.reasoning, {
        effort: "medium",
        summary: "auto",
      });

      return Response.json({
        output: [{
          content: [{ type: "output_text", text: "Good feedback." }],
        }],
      });
    },
    async (base) => {
      const client = createZenClient(base, "test-key");
      const chunks: string[] = [];
      for await (
        const chunk of client.chat({
          model: "gpt-5.5",
          messages: [
            { role: "system", content: "Stable project context" },
            { role: "user", content: "Review this." },
          ],
          stream: false,
          maxTokens: 2048,
        })
      ) {
        chunks.push(chunk);
      }
      assertEquals(chunks, ["Good feedback."]);
    },
  );
});

Deno.test("ZenClient - Gemini models use generateContent", async () => {
  await withMockServer(
    async (req) => {
      const url = new URL(req.url);
      assertEquals(
        url.pathname,
        "/models/gemini-3.5-flash:generateContent",
      );
      assertEquals(req.headers.get("x-goog-api-key"), "test-key");
      assertEquals(req.headers.get("Authorization"), null);

      const body = await req.json();
      assertEquals(body.systemInstruction, {
        parts: [{ text: "Stable project context" }],
      });
      assertEquals(body.contents, [
        { role: "user", parts: [{ text: "First question." }] },
        { role: "model", parts: [{ text: "First answer." }] },
        { role: "user", parts: [{ text: "Review this." }] },
      ]);
      assertEquals(body.generationConfig.thinkingConfig, {
        includeThoughts: true,
      });

      return Response.json({
        candidates: [{
          content: { parts: [{ text: "Good feedback." }] },
        }],
      });
    },
    async (base) => {
      const client = createZenClient(base, "test-key");
      const chunks: string[] = [];
      for await (
        const chunk of client.chat({
          model: "gemini-3.5-flash",
          messages: [
            { role: "system", content: "Stable project context" },
            { role: "user", content: "First question." },
            { role: "assistant", content: "First answer." },
            { role: "user", content: "Review this." },
          ],
          stream: false,
        })
      ) {
        chunks.push(chunk);
      }
      assertEquals(chunks, ["Good feedback."]);
    },
  );
});

// --- chat (streaming / SSE) ---

Deno.test("ZenClient - chat streaming yields content deltas via SSE", async () => {
  const sseBody = [
    `data: ${
      JSON.stringify({
        choices: [{
          delta: { reasoning_content: "Reviewing structure." },
          finish_reason: null,
        }],
      })
    }`,
    `data: ${
      JSON.stringify({
        choices: [{ delta: { content: "Structural" }, finish_reason: null }],
      })
    }`,
    `data: ${
      JSON.stringify({
        choices: [{ delta: { content: " issue" }, finish_reason: null }],
      })
    }`,
    `data: ${
      JSON.stringify({
        choices: [{ delta: { content: "." }, finish_reason: "stop" }],
      })
    }`,
    "data: [DONE]",
  ].join("\n") + "\n";

  await withMockServer(
    () =>
      new Response(sseBody, {
        headers: { "Content-Type": "text/event-stream" },
      }),
    async (base) => {
      const client = createZenClient(base, "key");
      const chunks: string[] = [];
      const thinking: string[] = [];
      for await (
        const chunk of client.chat({
          model: "minimax-m2.5",
          messages: [{ role: "user", content: "Critique this." }],
          stream: true,
          onThinking: (text) => thinking.push(text),
        })
      ) {
        chunks.push(chunk);
      }
      assertEquals(chunks, ["Structural", " issue", "."]);
      assertEquals(thinking, ["Reviewing structure."]);
    },
  );
});

Deno.test("ZenClient - Claude messages streaming yields text deltas via SSE", async () => {
  const sseBody = [
    `data: ${JSON.stringify({ type: "message_start", message: {} })}`,
    `data: ${
      JSON.stringify({
        type: "content_block_delta",
        delta: { type: "thinking_delta", thinking: "Checking context." },
      })
    }`,
    `data: ${
      JSON.stringify({
        type: "content_block_delta",
        delta: { type: "text_delta", text: "Project" },
      })
    }`,
    `data: ${
      JSON.stringify({
        type: "content_block_delta",
        delta: { type: "text_delta", text: " issue" },
      })
    }`,
    `data: ${JSON.stringify({ type: "message_stop" })}`,
  ].join("\n") + "\n";

  await withMockServer(
    () =>
      new Response(sseBody, {
        headers: { "Content-Type": "text/event-stream" },
      }),
    async (base) => {
      const client = createZenClient(base, "key");
      const chunks: string[] = [];
      const thinking: string[] = [];
      for await (
        const chunk of client.chat({
          model: "claude-haiku-4-5",
          messages: [{ role: "user", content: "Critique this." }],
          stream: true,
          onThinking: (text) => thinking.push(text),
        })
      ) {
        chunks.push(chunk);
      }
      assertEquals(chunks, ["Project", " issue"]);
      assertEquals(thinking, ["Checking context."]);
    },
  );
});

Deno.test("ZenClient - GPT responses streaming yields text deltas via SSE", async () => {
  const sseBody = [
    `data: ${
      JSON.stringify({
        type: "response.reasoning_summary_text.delta",
        delta: "Checking context.",
      })
    }`,
    `data: ${
      JSON.stringify({
        type: "response.output_text.delta",
        delta: "Project",
      })
    }`,
    `data: ${
      JSON.stringify({
        type: "response.output_text.delta",
        delta: " issue",
      })
    }`,
    `data: ${JSON.stringify({ type: "response.completed" })}`,
  ].join("\n") + "\n";

  await withMockServer(
    (req) => {
      assertEquals(new URL(req.url).pathname, "/responses");
      return new Response(sseBody, {
        headers: { "Content-Type": "text/event-stream" },
      });
    },
    async (base) => {
      const client = createZenClient(base, "key");
      const chunks: string[] = [];
      const thinking: string[] = [];
      for await (
        const chunk of client.chat({
          model: "gpt-5.5",
          messages: [{ role: "user", content: "Critique this." }],
          stream: true,
          onThinking: (text) => thinking.push(text),
        })
      ) {
        chunks.push(chunk);
      }
      assertEquals(chunks, ["Project", " issue"]);
      assertEquals(thinking, ["Checking context."]);
    },
  );
});

Deno.test("ZenClient - Gemini streaming yields candidate text via SSE", async () => {
  const sseBody = [
    `data: ${
      JSON.stringify({
        candidates: [{
          content: { parts: [{ text: "Checking context.", thought: true }] },
        }],
      })
    }`,
    `data: ${
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: "Project" }] } }],
      })
    }`,
    `data: ${
      JSON.stringify({
        candidates: [{
          content: { parts: [{ text: " issue" }] },
          finishReason: "STOP",
        }],
      })
    }`,
  ].join("\n") + "\n";

  await withMockServer(
    (req) => {
      const url = new URL(req.url);
      assertEquals(
        url.pathname,
        "/models/gemini-3.5-flash:streamGenerateContent",
      );
      assertEquals(url.searchParams.get("alt"), "sse");
      return new Response(sseBody, {
        headers: { "Content-Type": "text/event-stream" },
      });
    },
    async (base) => {
      const client = createZenClient(base, "key");
      const chunks: string[] = [];
      const thinking: string[] = [];
      for await (
        const chunk of client.chat({
          model: "gemini-3.5-flash",
          messages: [{ role: "user", content: "Critique this." }],
          stream: true,
          onThinking: (text) => thinking.push(text),
        })
      ) {
        chunks.push(chunk);
      }
      assertEquals(chunks, ["Project", " issue"]);
      assertEquals(thinking, ["Checking context."]);
    },
  );
});

// --- usage reporting ---

Deno.test("ZenClient - chat streaming reports normalized usage after stop", async () => {
  const sseBody = [
    `data: ${
      JSON.stringify({
        choices: [{ delta: { content: "Text" }, finish_reason: null }],
      })
    }`,
    `data: ${
      JSON.stringify({
        choices: [{ delta: {}, finish_reason: "stop" }],
      })
    }`,
    `data: ${
      JSON.stringify({
        choices: [],
        usage: {
          prompt_tokens: 1200,
          completion_tokens: 300,
          prompt_tokens_details: { cached_tokens: 1000 },
        },
      })
    }`,
    "data: [DONE]",
  ].join("\n") + "\n";

  await withMockServer(
    async (req) => {
      const body = await req.json();
      assertEquals(body.stream_options, { include_usage: true });
      return new Response(sseBody, {
        headers: { "Content-Type": "text/event-stream" },
      });
    },
    async (base) => {
      const client = createZenClient(base, "key");
      const chunks: string[] = [];
      const usages: unknown[] = [];
      for await (
        const chunk of client.chat({
          model: "minimax-m2.5",
          messages: [],
          stream: true,
          onUsage: (u) => usages.push(u),
        })
      ) {
        chunks.push(chunk);
      }
      assertEquals(chunks, ["Text"]);
      assertEquals(usages, [{
        inputTokens: 200,
        outputTokens: 300,
        cacheReadTokens: 1000,
        cacheWriteTokens: 0,
      }]);
    },
  );
});

Deno.test("ZenClient - Claude streaming merges message_start and message_delta usage", async () => {
  const sseBody = [
    `data: ${
      JSON.stringify({
        type: "message_start",
        message: {
          usage: {
            input_tokens: 40,
            cache_read_input_tokens: 5000,
            cache_creation_input_tokens: 100,
          },
        },
      })
    }`,
    `data: ${
      JSON.stringify({
        type: "content_block_delta",
        delta: { type: "text_delta", text: "Text" },
      })
    }`,
    `data: ${
      JSON.stringify({
        type: "message_delta",
        usage: { output_tokens: 250 },
      })
    }`,
    `data: ${JSON.stringify({ type: "message_stop" })}`,
  ].join("\n") + "\n";

  await withMockServer(
    () =>
      new Response(sseBody, {
        headers: { "Content-Type": "text/event-stream" },
      }),
    async (base) => {
      const client = createZenClient(base, "key");
      const usages: Array<Record<string, number>> = [];
      for await (
        const _ of client.chat({
          model: "claude-haiku-4-5",
          messages: [],
          stream: true,
          onUsage: (u) => usages.push({ ...u }),
        })
      ) { /* consume */ }
      assertEquals(usages.at(-1), {
        inputTokens: 40,
        outputTokens: 250,
        cacheReadTokens: 5000,
        cacheWriteTokens: 100,
      });
    },
  );
});

Deno.test("ZenClient - GPT responses streaming reports usage on completion", async () => {
  const sseBody = [
    `data: ${
      JSON.stringify({ type: "response.output_text.delta", delta: "Text" })
    }`,
    `data: ${
      JSON.stringify({
        type: "response.completed",
        response: {
          usage: {
            input_tokens: 900,
            output_tokens: 120,
            input_tokens_details: { cached_tokens: 800 },
          },
        },
      })
    }`,
  ].join("\n") + "\n";

  await withMockServer(
    () =>
      new Response(sseBody, {
        headers: { "Content-Type": "text/event-stream" },
      }),
    async (base) => {
      const client = createZenClient(base, "key");
      const usages: unknown[] = [];
      for await (
        const _ of client.chat({
          model: "gpt-5.5",
          messages: [],
          stream: true,
          onUsage: (u) => usages.push(u),
        })
      ) { /* consume */ }
      assertEquals(usages, [{
        inputTokens: 100,
        outputTokens: 120,
        cacheReadTokens: 800,
        cacheWriteTokens: 0,
      }]);
    },
  );
});

Deno.test("ZenClient - Gemini streaming reports cumulative usage metadata", async () => {
  const sseBody = [
    `data: ${
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: "Text" }] } }],
        usageMetadata: { promptTokenCount: 700, candidatesTokenCount: 10 },
      })
    }`,
    `data: ${
      JSON.stringify({
        candidates: [{
          content: { parts: [{ text: " more" }] },
          finishReason: "STOP",
        }],
        usageMetadata: {
          promptTokenCount: 700,
          candidatesTokenCount: 80,
          thoughtsTokenCount: 20,
          cachedContentTokenCount: 500,
        },
      })
    }`,
  ].join("\n") + "\n";

  await withMockServer(
    () =>
      new Response(sseBody, {
        headers: { "Content-Type": "text/event-stream" },
      }),
    async (base) => {
      const client = createZenClient(base, "key");
      const usages: Array<Record<string, number>> = [];
      for await (
        const _ of client.chat({
          model: "gemini-3.5-flash",
          messages: [],
          stream: true,
          onUsage: (u) => usages.push({ ...u }),
        })
      ) { /* consume */ }
      assertEquals(usages.at(-1), {
        inputTokens: 200,
        outputTokens: 100,
        cacheReadTokens: 500,
        cacheWriteTokens: 0,
      });
    },
  );
});

Deno.test("ZenClient - chat streaming stops at [DONE]", async () => {
  const sseBody = [
    `data: ${
      JSON.stringify({
        choices: [{ delta: { content: "Only this" }, finish_reason: null }],
      })
    }`,
    "data: [DONE]",
    `data: ${
      JSON.stringify({
        choices: [{ delta: { content: "never" }, finish_reason: null }],
      })
    }`,
  ].join("\n") + "\n";

  await withMockServer(
    () => new Response(sseBody),
    async (base) => {
      const client = createZenClient(base, "key");
      const chunks: string[] = [];
      for await (
        const chunk of client.chat({
          model: "minimax-m2.5",
          messages: [],
          stream: true,
        })
      ) {
        chunks.push(chunk);
      }
      assertEquals(chunks, ["Only this"]);
    },
  );
});

Deno.test("ZenClient - chat throws on non-200 response", async () => {
  await withMockServer(
    () => new Response("unauthorized", { status: 401 }),
    async (base) => {
      const client = createZenClient(base, "bad-key");
      await assertRejects(async () => {
        for await (
          const _ of client.chat({
            model: "minimax-m2.5",
            messages: [],
            stream: true,
          })
        ) { /* consume */ }
      });
    },
  );
});

Deno.test("ZenClient - fetchCatalog result is cached on second call", async () => {
  let callCount = 0;

  await withMockServer(
    (_req) => {
      callCount++;
      return Response.json({
        object: "list",
        data: [{
          id: "minimax-m2.5",
          object: "model",
          created: 0,
          owned_by: "opencode",
        }],
      });
    },
    async (base) => {
      const client = createZenClient(base, "key");
      const first = await client.fetchCatalog();
      const second = await client.fetchCatalog();
      assertEquals(callCount, 1);
      assertEquals(first, second);
    },
  );
});
