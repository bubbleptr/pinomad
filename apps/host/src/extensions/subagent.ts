// Built-in extension (roadmap M2): a foreground subagent — the call blocks until
// a child conversation it owns answers. The child is created inside the call's
// commit with `ownership: { kind: "task" }`, so a rerun after a host restart
// finds it through the ownership index instead of delegating twice, and the
// input's requestId dedupes a resubmission. Owned work cascades: aborting the
// call aborts the child, and the parent stays busy until the child is idle.
// The child starts as a copy of the parent's agent — same cwd, so the same
// checkout (ADR-0010 §5) — minus this extension (no recursion) and `exclude`.
import { clampThinkingLevel, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import {
  AgentDoc,
  type AgentChange,
  AssistantEntry,
  configure,
  defineExtension,
  defineTool,
  type Extension,
  type ModelRef,
  type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import type { ModelSummary } from "@pinomad/protocol/view.ts";
import type { BuiltinExtension } from "../builtin-extension.ts";

const INSTRUCTIONS =
  "You are a subagent working on one delegated task. You cannot ask the user questions; if you need a decision or clarification, stop and state exactly what you need in your final answer. Your final message is returned to the delegating agent as the result, so make it a complete, self-contained report.";

// pi-ai `ModelThinkingLevel`: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max".
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly ModelThinkingLevel[];

export function createSubagent(options: {
  readonly models: Models;
  /** The models the host advertises — what `model` may select and what the description lists. */
  readonly modelSummaries: () => readonly ModelSummary[];
  /** Extensions removed from the child besides this one, e.g. `question`. */
  readonly exclude: readonly Extension[];
}): BuiltinExtension {
  const available = (): string => options.modelSummaries().map((model) => `${model.provider}/${model.modelId}`).join(", ");

  const tool = defineTool({
    name: "subagent",
    description:
      "Delegate a self-contained task to a subagent that runs in its own conversation and returns its final answer. " +
      "The subagent starts with none of this conversation's context, so put everything it needs in `task`. " +
      "It works in the same files as you: subagents called in the same turn run concurrently, so give parallel subagents read-only work or non-overlapping files. " +
      "It cannot ask the user questions. `model` and `thinkingLevel` override what it inherits from you. " +
      `Available models: ${available()}.`,
    parameters: Type.Object({
      task: Type.String({
        minLength: 1,
        description: "Complete, self-contained instructions. The subagent sees none of this conversation.",
      }),
      model: Type.Optional(Type.String({ description: "Optional `provider/modelId` to use instead of yours." })),
      thinkingLevel: Type.Optional(
        Type.Union(
          THINKING_LEVELS.map((level) => Type.Literal(level)),
          { description: "Optional thinking level instead of yours." },
        ),
      ),
    }),
    // A rerun finds its child and submission instead of duplicating them.
    replay: "safe",
    execute: async (args, api, context) => {
      const child = await api.commit(async (tx) => {
        const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
        if (existing !== undefined) return existing.id;
        let model: ModelRef | undefined;
        let thinkingLevel: ModelThinkingLevel | undefined;
        let override: ReturnType<Models["getModel"]>;
        if (args.model !== undefined) {
          const slash = args.model.indexOf("/");
          const provider = slash === -1 ? "" : args.model.slice(0, slash);
          const modelId = slash === -1 ? "" : args.model.slice(slash + 1);
          override = provider === "" || modelId === "" ? undefined : options.models.getModel(provider, modelId);
          const listed = options.modelSummaries().some((each) => each.provider === provider && each.modelId === modelId);
          if (override === undefined || !listed) throw new Error(`Unknown model "${args.model}". Available models: ${available()}`);
          model = { provider, modelId };
        }
        if (args.thinkingLevel !== undefined || override !== undefined) {
          const parent = await tx.doc(AgentDoc, api.conversationId);
          // Clamp against the model the child will run; without any model there is nothing to clamp to.
          const effective = override ?? (parent.model === undefined ? undefined : options.models.getModel(parent.model.provider, parent.model.modelId));
          if (args.thinkingLevel !== undefined) {
            thinkingLevel = effective === undefined ? args.thinkingLevel : clampThinkingLevel(effective, args.thinkingLevel);
          } else if (parent.thinkingLevel !== undefined) {
            // Model without a thinking level: the child keeps the caller's, clamped to the new model.
            thinkingLevel = clampThinkingLevel(override!, parent.thinkingLevel);
          }
        }
        const change: AgentChange = {
          extensions: { remove: [extension, ...options.exclude] },
          instructions: INSTRUCTIONS,
          ...(model === undefined ? {} : { model }),
          ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
        };
        const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
        await configure(tx, created.id, change);
        return created.id;
      }, context);
      // Lets clients attach to the child while the call runs (and after, via the result details).
      await api.details({ conversationId: child }, context);
      const handle = await api.conversation(child, context);
      if (handle === undefined) throw new Error(`Subagent conversation ${child} does not exist`);
      const request = { type: "input", content: args.task, requestId: `subagent:${api.taskId}` } as const;
      const settled = await (await handle.submit(request, context)).wait(context);
      if (settled.status !== "done" || settled.type !== "input") throw new Error(`Subagent failed: ${settled.status}`);
      const answer = await api.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
      const message = answer?.model?.[0];
      // pi-ai's AssistantMessage content is always a block array, never a string.
      const text =
        message?.role === "assistant" ? message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("") : "";
      const result: ToolExecutionResult = {
        content: [{ type: "text", text: text === "" ? "(The subagent returned no text.)" : text }],
        details: { conversationId: child },
      };
      return result;
    },
  });

  // Declared after `tool` because execute captures it for the child's extension
  // removal; it is initialized before any call can run.
  const extension = defineExtension({ name: "subagent", tools: [tool] });
  // Nested in a script, memo/owner bookkeeping of a child conversation would go wrong (ADR-0013 §2).
  return { extension, modelOnly: ["subagent"] };
}
