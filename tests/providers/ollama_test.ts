import { assertEquals, assertAlmostEquals, assertRejects } from "@std/assert";
import { createOllamaClient } from "../../src/providers/ollama.ts";

/**
 * Spin up a minimal HTTP server for one request, call the handler, then shut down.
 */
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

// --- listModels ---

Deno.test("OllamaClient - listModels returns model names", async () => {
  await withMockServer(
    () =>
      Response.json({
        models: [
          { name: "gemma3:12b" },
          { name: "nomic-embed-text" },
        ],
      }),
    async (base) => {
      const client = createOllamaClient(base);
      const models = await client.listModels();
      assertEquals(models, ["gemma3:12b", "nomic-embed-text"]);
    },
  );
});

Deno.test("OllamaClient - listModels throws on non-200", async () => {
  await withMockServer(
    () => new Response("not found", { status: 404 }),
    async (base) => {
      const client = createOllamaClient(base);
      await assertRejects(() => client.listModels());
    },
  );
});

Deno.test("OllamaClient - listModels throws on connection refused", async () => {
  const client = createOllamaClient("http://localhost:1"); // nothing listening
  await assertRejects(() => client.listModels());
});

// --- embed ---

Deno.test("OllamaClient - embed returns Float32Array", async () => {
  const embedding = [0.1, 0.2, 0.3];
  await withMockServer(
    async (req) => {
      const body = await req.json();
      assertEquals(body.model, "nomic-embed-text");
      assertEquals(body.prompt, "hello world");
      return Response.json({ embedding });
    },
    async (base) => {
      const client = createOllamaClient(base);
      const result = await client.embed("hello world", "nomic-embed-text");
      assertEquals(result instanceof Float32Array, true);
      assertEquals(result.length, embedding.length);
      // Float32Array has 32-bit precision; values don't round-trip exactly from float64.
      for (let i = 0; i < embedding.length; i++) {
        assertAlmostEquals(result[i], embedding[i], 1e-6);
      }
    },
  );
});

Deno.test("OllamaClient - embed throws on error response", async () => {
  await withMockServer(
    () => new Response("model not found", { status: 404 }),
    async (base) => {
      const client = createOllamaClient(base);
      await assertRejects(() => client.embed("text", "bad-model"));
    },
  );
});

Deno.test("OllamaClient - trailing slash in base URL is handled", async () => {
  await withMockServer(
    () => Response.json({ models: [{ name: "llama3" }] }),
    async (base) => {
      const client = createOllamaClient(base + "/"); // trailing slash
      const models = await client.listModels();
      assertEquals(models, ["llama3"]);
    },
  );
});
