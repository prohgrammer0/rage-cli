import { assertEquals } from "@std/assert";
import { getGhost } from "../../src/chat/input.ts";

Deno.test("Input - completes session commands", () => {
  assertEquals(getGhost(["/res"], []), "ume");
  assertEquals(getGhost(["/session"], []), "s");
});

Deno.test("Input - preserves existing command and role completion", () => {
  assertEquals(getGhost(["/hel"], []), "p");
  assertEquals(getGhost(["/role d"], []), "ev");
});
