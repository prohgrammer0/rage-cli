import type { ZenClient } from "../providers/zen.ts";
import type { RetrievalSearch } from "../retrieval/search.ts";
import type { Renderer } from "./renderer.ts";
import type { VaultEntry } from "../config/schema.ts";
import { assembleContext } from "../retrieval/context.ts";

const LINE_SYSTEM_PROMPT = `You are a line editor reviewing markdown documents. Your job is to provide
feedback on writing at the sentence and paragraph level. You critique clarity,
word choice, rhythm, redundancy, grammar, and precision.

You NEVER rewrite the text. You point out issues and explain why they are
issues. The writer does the writing.

You have no file system access or tools. Work only from the retrieved context
below. When referencing specific text, cite the file path and line numbers from
the context.

Retrieved context:
{context}`;

export interface LineEditorSession {
  send(message: string, onStart?: () => void): Promise<void>;
  resetHistory(): void;
}

export interface LineEditorConfig {
  model: string;
  contextMaxTokens: number;
  topK: number;
  vaults: VaultEntry[];
}

/**
 * Resolve an @mention to a full path prefix for queryByPath.
 * Single vault: @drafts/foo.md → {vault.path}/drafts/foo.md
 * Multiple vaults: @vaultname/drafts/foo.md → matching vault path + /drafts/foo.md
 * Returns "" if the vault name is not found (caller should warn and skip).
 */
function resolveAtMention(mention: string, vaults: VaultEntry[]): string {
  if (vaults.length === 1) {
    return vaults[0].path.replace(/\/$/, "") + "/" + mention;
  }
  const slashIdx = mention.indexOf("/");
  const vaultName = slashIdx === -1 ? mention : mention.slice(0, slashIdx);
  const rest = slashIdx === -1 ? "" : mention.slice(slashIdx + 1);
  const vault = vaults.find((v) => v.name === vaultName);
  if (!vault) return "";
  return vault.path.replace(/\/$/, "") + (rest ? "/" + rest : "/");
}

export function createLineEditor(
  config: LineEditorConfig,
  retrieval: RetrievalSearch,
  zen: ZenClient,
  renderer: Renderer,
): LineEditorSession {
  type Message = { role: "system" | "user" | "assistant"; content: string };
  let history: Message[] = [];

  return {
    async send(message: string, onStart?: () => void): Promise<void> {
      const mentions = [...message.matchAll(/@([\w./\-]+)/g)].map((m) => m[1]);
      const pathMentions = mentions.filter((m) => m !== "vault");

      const atResults: typeof results = [];
      for (const mention of pathMentions) {
        const prefix = resolveAtMention(mention, config.vaults);
        if (!prefix) {
          const names = config.vaults.map((v) => v.name).join(", ");
          renderer.log("warn", `@${mention}: unknown vault. Available: ${names}`);
          continue;
        }
        const chunks = retrieval.queryByPath(prefix);
        if (chunks.length === 0) {
          renderer.log("warn", `@${mention}: no indexed content found — check the path or run /ingest.`);
        }
        atResults.push(...chunks);
      }

      const results = await retrieval.query(message, config.topK);

      // Merge: @-referenced chunks (distance=0) first, then semantic results, deduplicated.
      const seen = new Set<string>();
      const merged: typeof results = [];
      for (const r of [...atResults, ...results]) {
        if (!seen.has(r.id)) { seen.add(r.id); merged.push(r); }
      }

      if (merged.length === 0) {
        renderer.log("warn", "No indexed content matched your query. Run /ingest if you haven't yet.");
        return;
      }
      const context = assembleContext(merged, config.contextMaxTokens);

      const systemContent = LINE_SYSTEM_PROMPT.replace("{context}", context);

      const messages: Message[] = [
        { role: "system", content: systemContent },
        ...history,
        { role: "user", content: message },
      ];

      const enc = new TextEncoder();
      let fullResponse = "";
      let started = false;

      try {
        for await (
          const delta of zen.chat({ model: config.model, messages, stream: true })
        ) {
          if (!started) { onStart?.(); started = true; }
          fullResponse += delta;
          await Deno.stdout.write(enc.encode(delta));
        }
      } catch (err) {
        renderer.log(
          "error",
          `Line editor error: ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }

      await Deno.stdout.write(enc.encode("\n"));
      history.push({ role: "user", content: message });
      history.push({ role: "assistant", content: fullResponse });
    },

    resetHistory(): void {
      history = [];
    },
  };
}
