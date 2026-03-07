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
          { id: "minimax-m2.5", object: "model", created: 0, owned_by: "opencode" },
          { id: "kimi-k2.5", object: "model", created: 0, owned_by: "opencode" },
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

// --- chat (streaming / SSE) ---

Deno.test("ZenClient - chat streaming yields content deltas via SSE", async () => {
  const sseBody = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: "Structural" }, finish_reason: null }] })}`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: " issue" }, finish_reason: null }] })}`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: "." }, finish_reason: "stop" }] })}`,
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
      for await (
        const chunk of client.chat({
          model: "minimax-m2.5",
          messages: [{ role: "user", content: "Critique this." }],
          stream: true,
        })
      ) {
        chunks.push(chunk);
      }
      assertEquals(chunks, ["Structural", " issue", "."]);
    },
  );
});

Deno.test("ZenClient - chat streaming stops at [DONE]", async () => {
  const sseBody = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: "Only this" }, finish_reason: null }] })}`,
    "data: [DONE]",
    `data: ${JSON.stringify({ choices: [{ delta: { content: "never" }, finish_reason: null }] })}`,
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
        data: [{ id: "minimax-m2.5", object: "model", created: 0, owned_by: "opencode" }],
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
