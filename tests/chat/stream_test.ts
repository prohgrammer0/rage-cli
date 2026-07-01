import { assertEquals } from "@std/assert";
import {
  createThinkingDisplay,
  renderTextStream,
} from "../../src/chat/stream.ts";

async function* chunks(values: string[]): AsyncIterable<string> {
  for (const value of values) yield value;
}

Deno.test("renderTextStream - coalesces deltas and preserves full text", async () => {
  const writes: string[] = [];
  let starts = 0;

  const result = await renderTextStream(chunks(["small", " ", "deltas"]), {
    onStart: () => {
      starts++;
    },
    write: (text) => writes.push(text),
    flushIntervalMs: 10_000,
    flushAtChars: 10_000,
  });

  assertEquals(result, "small deltas");
  assertEquals(writes, ["small deltas"]);
  assertEquals(starts, 1);
});

Deno.test("renderTextStream - flushes line breaks immediately", async () => {
  const writes: string[] = [];

  await renderTextStream(chunks(["first", "\n", "second"]), {
    write: (text) => writes.push(text),
    flushIntervalMs: 10_000,
    flushAtChars: 10_000,
  });

  assertEquals(writes, ["first\n", "second"]);
});

Deno.test("renderTextStream - ignores empty deltas", async () => {
  const writes: string[] = [];
  let starts = 0;

  const result = await renderTextStream(chunks(["", "text", ""]), {
    onStart: () => {
      starts++;
    },
    write: (text) => writes.push(text),
    flushIntervalMs: 10_000,
  });

  assertEquals(result, "text");
  assertEquals(writes, ["text"]);
  assertEquals(starts, 1);
});

Deno.test("createThinkingDisplay - smoothly preserves the full text", async () => {
  const writes: string[] = [];
  let starts = 0;
  const display = createThinkingDisplay({
    onStart: () => starts++,
    write: (text) => writes.push(text),
    frameIntervalMs: 0,
    useColor: false,
  });

  display.append("Checking the full");
  display.append(" project context.");
  await display.finish();
  await display.finish();

  assertEquals(
    writes.join(""),
    "thinking\nChecking the full project context.\n\n",
  );
  assertEquals(starts, 1);
});
