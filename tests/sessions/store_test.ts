import { assertEquals, assertExists } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { createSessionStore } from "../../src/sessions/store.ts";

Deno.test("SessionStore - creates, appends, lists, and restores sessions", async () => {
  const dir = await Deno.makeTempDir();
  const store = await createSessionStore(`${dir}/sessions.db`);
  try {
    const session = store.create({
      project: "book",
      sourceLabel: "book: /notes/book",
      editorRole: "dev",
      model: "claude-opus-4-8",
      contextHash: "hash-one",
    });

    store.appendTurn(session.id, "Review chapter one.", "The opening is slow.");
    store.appendTurn(
      session.id,
      "What about the ending?",
      "The turn is abrupt.",
    );

    const restored = store.get(session.id);
    assertExists(restored);
    assertEquals(restored.messages, [
      { role: "user", content: "Review chapter one." },
      { role: "assistant", content: "The opening is slow." },
      { role: "user", content: "What about the ending?" },
      { role: "assistant", content: "The turn is abrupt." },
    ]);

    const summaries = store.list("book");
    assertEquals(summaries.length, 1);
    assertEquals(summaries[0].id, session.id);
    assertEquals(summaries[0].messageCount, 4);
    assertEquals(summaries[0].preview, "Review chapter one.");
    assertEquals(store.list("another-project"), []);
  } finally {
    store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("SessionStore - does not list empty sessions", async () => {
  const store = await createSessionStore(":memory:");
  try {
    store.create({
      project: "book",
      sourceLabel: "book",
      editorRole: "line",
      model: "gemini-3.5-flash",
      contextHash: "hash",
    });
    assertEquals(store.list("book"), []);
  } finally {
    store.close();
  }
});

Deno.test("SessionStore - rejects newer schema versions", async () => {
  const path = await Deno.makeTempFile({ suffix: ".db" });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA user_version = 2");
  db.close();

  try {
    let message = "";
    try {
      await createSessionStore(path);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assertEquals(
      message,
      "Session database schema version 2 is newer than supported version 1.",
    );
  } finally {
    await Deno.remove(path);
  }
});
