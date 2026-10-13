// Auto-title: name a conversation once, after its first successful run, with
// the host's effective default model (ADR-0021). The ConversationList's commit
// listener reports run ends; this module does the slow part (entry scan, one
// model call, the TitleDoc write). A title that exists — auto or manual — is
// never regenerated, and every failure path is silent: titling is a nicety,
// never worth a notice.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import type { Models } from "@earendil-works/pi-ai/models";
import type { Context as ModelContext } from "@earendil-works/pi-ai";
import type { ConversationId, Cursor, EntryRecord, Harness } from "@earendil-works/pi-durable";
import type { HostSettingsStore } from "./host-settings.ts";
import { TitleDoc } from "./title-doc.ts";

const context: Context = BACKGROUND_CONTEXT;

const TITLE_PROMPT =
  "You name conversations between a user and a coding agent. Reply with only the title: at most 6 words" +
  " (about 20 characters for Chinese or Japanese), in the same language as the user's message, no quotes," +
  " no trailing punctuation. Name the task, not the agent's answer.";

const TITLE_INPUT_LIMIT = 2000;
const TITLE_MAX_LENGTH = 80;

/** What `ConversationList` reports when a conversation's run ends. */
export interface RunEndSource {
  /** Fires inside the commit listener — defer any Session work out of it. */
  onRunEnd(listener: (id: ConversationId) => void): () => void;
}

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) =>
      typeof block === "object" && block !== null && (block as { type?: string }).type === "text"
        ? [(block as { text?: string }).text ?? ""]
        : [],
    )
    .join("");
};

/**
 * What a model's raw answer cleans down to: the first non-empty line, minus a
 * "Title:" prefix, surrounding quotes, and trailing punctuation — or undefined
 * when nothing usable came back.
 */
export function cleanTitle(raw: string): string | undefined {
  const line = raw
    .split("\n")
    .map((each) => each.trim())
    .find((each) => each !== "");
  if (line === undefined) return undefined;
  let text = line.replace(/^\s*title\s*:\s*/i, "");
  // Quotes can sit outside trailing punctuation ("「title」。"): strip both
  // until neither changes.
  let before = "";
  while (text !== before) {
    before = text;
    text = text
      .replace(/^["'“”‘’「」`]+/, "")
      .replace(/["'“”‘’「」`]+$/, "")
      .replace(/[.。!！?？]+$/, "");
  }
  text = text.replace(/\s+/g, " ").trim();
  if (text === "") return undefined;
  // The cap can cut mid-word and leave a trailing space.
  return text.length > TITLE_MAX_LENGTH ? text.slice(0, TITLE_MAX_LENGTH).trimEnd() : text;
}

/**
 * Subscribe to run ends and title the conversation's first successful one.
 * Returns the unsubscribe; failures log one line and move on.
 */
export function attachAutoTitle(
  runs: RunEndSource,
  deps: { harness: Harness; models: Models; settings: HostSettingsStore },
): () => void {
  const inFlight = new Set<ConversationId>();

  const title = async (id: ConversationId): Promise<void> => {
    try {
      const existing = await deps.harness.snapshot(TitleDoc, id, context);
      if (typeof existing?.title === "string" && existing.title !== "") return;

      const conversation = await deps.harness.conversation(id, context);
      if (conversation === undefined) return;
      let first: EntryRecord | undefined;
      let newest: EntryRecord | undefined;
      let cursor: Cursor | undefined;
      do {
        const page = await conversation.entries({}, 256, cursor, context);
        first = page.items.findLast((entry) => entry.kind === "pi.user" && entry.conversationId === id) ?? first;
        newest ??= page.items.find((entry) => entry.conversationId === id && entry.kind === "pi.assistant");
        cursor = page.next;
      } while (cursor !== undefined);
      const last = newest?.model?.[0] as { role?: string; stopReason?: string; content?: unknown } | undefined;
      // Only a run that ended well earns the name; a failed or aborted one
      // leaves it for the next successful run.
      if (first === undefined || last?.role !== "assistant" || last.stopReason === "error" || last.stopReason === "aborted") {
        return;
      }

      const ref = deps.settings.value.defaultModel;
      const model = ref === null ? undefined : deps.models.getModel(ref.provider, ref.modelId);
      if (model === undefined) return;

      const firstText = textOf(first.model?.[0] !== undefined ? (first.model[0] as { content?: unknown }).content : "").slice(
        0,
        TITLE_INPUT_LIMIT,
      );
      const answer = textOf(last.content).slice(0, TITLE_INPUT_LIMIT);
      const request: ModelContext = {
        systemPrompt: TITLE_PROMPT,
        messages: [
          {
            role: "user",
            content: `User's first message:\n${firstText}${answer === "" ? "" : `\n\nAgent's reply:\n${answer}`}`,
            timestamp: Date.now(),
          },
        ],
      };
      const generated = await deps.models.completeSimple(model, request, { maxTokens: 256 });
      const cleaned = cleanTitle(generated.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join(""));
      if (generated.stopReason === "error" || cleaned === undefined) {
        console.error(
          `auto-title: conversation ${id}: ${generated.stopReason === "error" ? (generated.errorMessage ?? "provider error") : "unusable model output"}`,
        );
        return;
      }

      // The title write re-reads the doc inside the commit: a rename that
      // landed while the model worked wins — manual or earlier auto.
      await deps.harness.commit(async (tx) => {
        const doc = await tx.doc(TitleDoc, id);
        if (typeof doc.title === "string" && doc.title !== "") return;
        doc.title = cleaned;
        doc.source = "auto";
      }, context);
    } catch (error) {
      console.error(`auto-title: conversation ${id}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      inFlight.delete(id);
    }
  };

  return runs.onRunEnd((id) => {
    if (inFlight.has(id)) return;
    inFlight.add(id);
    // Commit listeners may not touch Session APIs; the work starts once the
    // listener has returned.
    setImmediate(() => void title(id));
  });
}
