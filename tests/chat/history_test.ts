import { assertEquals } from "@std/assert";
import { PromptHistory } from "../../src/chat/history.ts";

Deno.test("PromptHistory - navigates older and newer prompts", () => {
  const history = new PromptHistory();
  history.record("first");
  history.record("second");
  history.begin();

  assertEquals(history.previous("draft"), "second");
  assertEquals(history.previous("second"), "first");
  assertEquals(history.previous("first"), null);
  assertEquals(history.next(), "second");
  assertEquals(history.next(), "draft");
  assertEquals(history.next(), null);
});

Deno.test("PromptHistory - suppresses consecutive duplicates", () => {
  const history = new PromptHistory();
  history.record("same");
  history.record("same");
  history.begin();

  assertEquals(history.previous(""), "same");
  assertEquals(history.previous("same"), null);
});

Deno.test("PromptHistory - enforces its entry limit", () => {
  const history = new PromptHistory(2);
  history.record("first");
  history.record("second");
  history.record("third");
  history.begin();

  assertEquals(history.previous(""), "third");
  assertEquals(history.previous("third"), "second");
  assertEquals(history.previous("second"), null);
});
