import { assertEquals } from "@std/assert";
import { getGhost } from "../../src/chat/input.ts";

Deno.test("Input - completes session commands", () => {
  assertEquals(getGhost(["/res"], []), "ume");
  assertEquals(getGhost(["/session"], []), "s");
});

Deno.test("Input - completes /reload without shadowing /resume", () => {
  assertEquals(getGhost(["/rel"], []), "oad");
  assertEquals(getGhost(["/res"], []), "ume");
});

Deno.test("Input - preserves existing command and role completion", () => {
  assertEquals(getGhost(["/hel"], []), "p");
  assertEquals(getGhost(["/role d"], []), "ev");
});
