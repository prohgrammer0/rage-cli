import { assertEquals } from "@std/assert";
import { handleCommand } from "../../src/chat/commands.ts";
import { createRenderer } from "../../src/chat/renderer.ts";
import { createModelRegistry } from "../../src/config/models.ts";
import { loadConfig } from "../../src/config/loader.ts";
import type { CommandContext } from "../../src/chat/commands.ts";

const LOCAL = ["nomic-embed-text:latest"];
const ZEN = ["minimax-m2.5", "kimi-k2.5", "glm-5"];

async function makeCtx(): Promise<{
  ctx: CommandContext;
  roleChanges: string[];
  modelChanges: string[];
  quits: number;
}> {
  const config = await loadConfig({});
  const registry = createModelRegistry(config);
  registry.initialize(LOCAL, ZEN);

  const roleChanges: string[] = [];
  const modelChanges: string[] = [];
  let quits = 0;

  const ctx: CommandContext = {
    role: "line",
    modelRegistry: registry,
    queries: {
      upsertChunk: () => {},
      pruneFile: () => [],
      getChunk: () => null,
      getChunkIdsByFile: () => [],
      search: () => [],
      getFileState: () => null,
      setFileState: () => {},
      hasChunks: () => true,
      countStaleFiles: () => 0,
      getAllFilePaths: () => [],
      getChunksByPathPrefix: () => [],
    },
    pipeline: null,
    pipelineOptions: null,
    renderer: createRenderer({ useColor: false }),
    onRoleChange: (r) => roleChanges.push(r),
    onModelChange: (m) => modelChanges.push(m),
    onQuit: () => quits++,
  };

  return { ctx, roleChanges, modelChanges, quits };
}

// --- /role ---

Deno.test("Commands - /role line switches role", async () => {
  const { ctx, roleChanges } = await makeCtx();
  const result = await handleCommand("/role line", ctx);
  assertEquals(result.type, "ok");
  assertEquals(roleChanges, ["line"]);
});

Deno.test("Commands - /role dev switches role", async () => {
  const { ctx, roleChanges } = await makeCtx();
  const result = await handleCommand("/role dev", ctx);
  assertEquals(result.type, "ok");
  assertEquals(roleChanges, ["dev"]);
});

Deno.test("Commands - /role with invalid value returns ok (logs error)", async () => {
  const { ctx, roleChanges } = await makeCtx();
  const result = await handleCommand("/role invalid", ctx);
  assertEquals(result.type, "ok");
  assertEquals(roleChanges.length, 0);
});

// --- /model ---

Deno.test("Commands - /model without tag lists models", async () => {
  const { ctx } = await makeCtx();
  const result = await handleCommand("/model", ctx);
  assertEquals(result.type, "ok");
});

Deno.test("Commands - /model <tag> switches model when available", async () => {
  const { ctx, modelChanges } = await makeCtx();
  const result = await handleCommand("/model minimax-m2.5", ctx);
  assertEquals(result.type, "ok");
  assertEquals(modelChanges, ["minimax-m2.5"]);
});

Deno.test("Commands - /model <tag> with unavailable model returns ok (logs error)", async () => {
  const { ctx, modelChanges } = await makeCtx();
  const result = await handleCommand("/model nonexistent:model", ctx);
  assertEquals(result.type, "ok");
  assertEquals(modelChanges.length, 0);
});

// --- /ingest ---

Deno.test("Commands - /ingest without pipeline logs error", async () => {
  const { ctx } = await makeCtx();
  const result = await handleCommand("/ingest", ctx);
  assertEquals(result.type, "ok");
});

Deno.test("Commands - /ingest with pipeline calls pipeline.run", async () => {
  const { ctx } = await makeCtx();
  let ran = false;
  ctx.pipeline = {
    run: async () => {
      ran = true;
      return {
        filesScanned: 1,
        filesSkipped: 0,
        filesProcessed: 1,
        filesPruned: 0,
        chunksCreated: 2,
        chunksReused: 0,
        chunksPruned: 0,
      };
    },
  };
  ctx.pipelineOptions = [{
    vaultPath: "/vault",
    extensions: [".md"],
    chunkSize: 512,
    chunkOverlap: 64,
    embeddingModel: "nomic-embed-text",
  }];
  const result = await handleCommand("/ingest", ctx);
  assertEquals(result.type, "ok");
  assertEquals(ran, true);
});

// --- /help ---

Deno.test("Commands - /help returns ok", async () => {
  const { ctx } = await makeCtx();
  const result = await handleCommand("/help", ctx);
  assertEquals(result.type, "ok");
});

// --- /quit ---

Deno.test("Commands - /quit returns quit result", async () => {
  const { ctx } = await makeCtx();
  let quitCalled = false;
  ctx.onQuit = () => { quitCalled = true; };
  const result = await handleCommand("/quit", ctx);
  assertEquals(result.type, "quit");
  assertEquals(quitCalled, true);
});

Deno.test("Commands - /exit also quits", async () => {
  const { ctx } = await makeCtx();
  const result = await handleCommand("/exit", ctx);
  assertEquals(result.type, "quit");
});

// --- unknown ---

Deno.test("Commands - unknown command returns unknown result", async () => {
  const { ctx } = await makeCtx();
  const result = await handleCommand("/unknown", ctx);
  assertEquals(result.type, "unknown");
});
