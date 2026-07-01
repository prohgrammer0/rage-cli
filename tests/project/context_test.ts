import { assertEquals, assertStringIncludes } from "@std/assert";
import { buildProjectContextPack } from "../../src/project/context.ts";

Deno.test("buildProjectContextPack - formats external vault files deterministically", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/drafts`);
    await Deno.writeTextFile(`${dir}/drafts/b.md`, "Second\nfile");
    await Deno.writeTextFile(`${dir}/a.md`, "First file");
    await Deno.writeTextFile(`${dir}/ignore.txt`, "Nope");

    const pack = await buildProjectContextPack({
      sources: [],
      vaults: [{ path: dir, name: "vault" }],
      extensions: [".md"],
      maxTokens: 10000,
    });

    assertEquals(pack.files.map((file) => file.path), ["a.md", "drafts/b.md"]);
    assertStringIncludes(pack.content, `<file path="a.md">`);
    assertStringIncludes(pack.content, "1: First file");
    assertStringIncludes(pack.content, `<file path="drafts/b.md">`);
    assertStringIncludes(pack.content, "2: file");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("buildProjectContextPack - skips hidden Obsidian files", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/.obsidian`);
    await Deno.writeTextFile(`${dir}/.obsidian/app.json`, "{}");
    await Deno.writeTextFile(`${dir}/note.md`, "Visible");

    const pack = await buildProjectContextPack({
      sources: [],
      vaults: [{ path: dir, name: "vault" }],
      extensions: [".md", ".json"],
      maxTokens: 10000,
    });

    assertEquals(pack.files.map((file) => file.path), ["note.md"]);
    assertEquals(pack.content.includes(".obsidian"), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("buildProjectContextPack - prefixes paths for multiple vaults", async () => {
  const a = await Deno.makeTempDir();
  const b = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${a}/note.md`, "A");
    await Deno.writeTextFile(`${b}/note.md`, "B");

    const pack = await buildProjectContextPack({
      sources: [],
      vaults: [
        { path: a, name: "a" },
        { path: b, name: "b" },
      ],
      extensions: [".md"],
      maxTokens: 10000,
    });

    assertEquals(pack.files.map((file) => file.path), [
      "a/note.md",
      "b/note.md",
    ]);
  } finally {
    await Deno.remove(a, { recursive: true });
    await Deno.remove(b, { recursive: true });
  }
});

Deno.test("buildProjectContextPack - includes explicit file sources anywhere on disk", async () => {
  const a = await Deno.makeTempDir();
  const b = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${a}/note.md`, "A");
    await Deno.writeTextFile(`${b}/style.txt`, "B");

    const pack = await buildProjectContextPack({
      sources: [
        { path: `${a}/note.md`, name: "personal/note.md" },
        { path: `${b}/style.txt`, name: "style/style.txt" },
      ],
      vaults: [],
      extensions: [".md"],
      maxTokens: 10000,
    });

    assertEquals(pack.files.map((file) => file.path), [
      "personal/note.md",
      "style/style.txt",
    ]);
    assertStringIncludes(pack.content, `<file path="style/style.txt">`);
  } finally {
    await Deno.remove(a, { recursive: true });
    await Deno.remove(b, { recursive: true });
  }
});

Deno.test("buildProjectContextPack - directory sources use display prefix and extension filter", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/keep.md`, "Keep");
    await Deno.writeTextFile(`${dir}/ignore.txt`, "Ignore");

    const pack = await buildProjectContextPack({
      sources: [{ path: dir, name: "loose" }],
      vaults: [],
      extensions: [".md"],
      maxTokens: 10000,
    });

    assertEquals(pack.files.map((file) => file.path), ["loose/keep.md"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("buildProjectContextPack - glob sources can span nested files", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/nested`);
    await Deno.writeTextFile(`${dir}/a.md`, "A");
    await Deno.writeTextFile(`${dir}/nested/b.md`, "B");
    await Deno.writeTextFile(`${dir}/nested/c.txt`, "C");

    const pack = await buildProjectContextPack({
      sources: [{ path: `${dir}/**/*.md`, name: "scattered" }],
      vaults: [],
      extensions: [".md"],
      maxTokens: 10000,
    });

    assertEquals(pack.files.map((file) => file.path), [
      "scattered/a.md",
      "scattered/nested/b.md",
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("buildProjectContextPack - skips files that exceed token budget", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/large.md`, "x".repeat(2000));
    await Deno.writeTextFile(`${dir}/small.md`, "small");

    const pack = await buildProjectContextPack({
      sources: [],
      vaults: [{ path: dir, name: "vault" }],
      extensions: [".md"],
      maxTokens: 100,
    });

    assertEquals(pack.files.map((file) => file.path), ["small.md"]);
    assertEquals(pack.filesSkipped, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
