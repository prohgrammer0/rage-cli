import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  createMarkdownStream,
  styleMarkdown,
} from "../../src/chat/markdown.ts";

function plain(text: string, width = 80): string {
  return styleMarkdown(text, { useColor: false, width });
}

// --- block styling (no color: structure transforms only) ---

Deno.test("styleMarkdown - strips heading markers", () => {
  assertEquals(plain("## Structure\n"), "Structure\n");
});

Deno.test("styleMarkdown - converts bullets to •", () => {
  assertEquals(plain("- first\n- second\n"), "• first\n• second\n");
});

Deno.test("styleMarkdown - preserves nested bullet indentation", () => {
  assertEquals(plain("- outer\n  - inner\n"), "• outer\n  • inner\n");
});

Deno.test("styleMarkdown - keeps numbered list markers", () => {
  assertEquals(plain("1. first\n2. second\n"), "1. first\n2. second\n");
});

Deno.test("styleMarkdown - converts blockquote to gutter", () => {
  assertEquals(plain("> quoted text\n"), "│ quoted text\n");
});

Deno.test("styleMarkdown - renders horizontal rule", () => {
  const out = plain("---\n");
  assertStringIncludes(out, "─".repeat(10));
});

Deno.test("styleMarkdown - plain paragraph passes through", () => {
  assertEquals(plain("Just a sentence.\n"), "Just a sentence.\n");
});

Deno.test("styleMarkdown - blank lines pass through", () => {
  assertEquals(plain("one\n\ntwo\n"), "one\n\ntwo\n");
});

// --- inline styling ---

Deno.test("styleMarkdown - strips inline code markers", () => {
  assertEquals(plain("see `notes.md` here\n"), "see notes.md here\n");
});

Deno.test("styleMarkdown - strips bold markers", () => {
  assertEquals(plain("a **strong claim** here\n"), "a strong claim here\n");
});

Deno.test("styleMarkdown - bold span containing spaces stays intact", () => {
  assertEquals(plain("**two words** end\n"), "two words end\n");
});

Deno.test("styleMarkdown - colors inline code when color on", () => {
  const out = styleMarkdown("see `notes.md` here\n", {
    useColor: true,
    width: 80,
  });
  assertStringIncludes(out, "\x1b[36mnotes.md");
});

Deno.test("styleMarkdown - unmatched marker flushes at line end", () => {
  assertEquals(plain("odd `tick here\n"), "odd `tick here\n");
});

// --- fenced code ---

Deno.test("styleMarkdown - swallows fence lines, keeps content", () => {
  const out = plain("```ts\nconst x = 1;\n```\nafter\n");
  assertEquals(out, "const x = 1;\nafter\n");
});

Deno.test("styleMarkdown - no inline parsing inside fences", () => {
  const out = plain("```\na ** b ` c\n```\n");
  assertEquals(out, "a ** b ` c\n");
});

// --- word wrap ---

Deno.test("styleMarkdown - wraps long prose at word boundaries", () => {
  const out = plain("alpha beta gamma delta epsilon\n", 12);
  assertEquals(out, "alpha beta\ngamma delta\nepsilon\n");
});

Deno.test("styleMarkdown - wrapped bullets get hanging indent", () => {
  const out = plain("- alpha beta gamma delta\n", 13);
  assertEquals(out, "• alpha beta\n  gamma delta\n");
});

Deno.test("styleMarkdown - word longer than width emits without split", () => {
  const out = plain("supercalifragilistic\n", 10);
  assertEquals(out, "supercalifragilistic\n");
});

// --- marker ---

Deno.test("styleMarkdown - marker prefixes first line, indents rest", () => {
  const out = plain("first line\nsecond line\n").length; // baseline sanity
  const marked = styleMarkdown("first\nsecond\n", {
    useColor: false,
    width: 80,
    marker: "●",
  });
  assertEquals(marked, "● first\n  second\n");
  assertEquals(typeof out, "number");
});

// --- streaming behavior ---

Deno.test("createMarkdownStream - identical output across chunk boundaries", () => {
  const text = "## Head\n\n- item **bold text** and `code`\nplain tail\n";
  const whole = styleMarkdown(text, { useColor: false, width: 80 });

  const stream = createMarkdownStream({ useColor: false, width: 80 });
  let out = "";
  for (const ch of text) out += stream.push(ch); // worst case: 1-char chunks
  out += stream.end();

  assertEquals(out, whole);
});

Deno.test("createMarkdownStream - emits words incrementally, not per line", () => {
  const stream = createMarkdownStream({ useColor: false, width: 80 });
  let out = stream.push("first words of a long paragraph ");
  assertStringIncludes(out, "first words of a long");
  out += stream.push("that keeps going");
  out += stream.end();
  assertEquals(out, "first words of a long paragraph that keeps going");
});

Deno.test("createMarkdownStream - strips raw escape bytes", () => {
  const stream = createMarkdownStream({ useColor: false, width: 80 });
  const out = stream.push("safe \x1b[31mtext\n") + stream.end();
  assertEquals(out, "safe [31mtext\n");
});
