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
  section,
  type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import type { AgentRole } from "@pinomad/protocol/agents.ts";
import type { ModelSummary } from "@pinomad/protocol/view.ts";
import type { BuiltinExtension } from "../builtin-extension.ts";
import { SubagentDoc } from "../subagent-doc.ts";

const INSTRUCTIONS =
  "You are a subagent working on one delegated task. You cannot ask the user questions; if you need a decision or clarification, stop and state exactly what you need in your final answer. Your final message is returned to the delegating agent as the result, so make it a complete, self-contained report.";

// pi-ai `ModelThinkingLevel`: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max".
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly ModelThinkingLevel[];

export function createSubagent(options: {
  readonly models: Models;
  /** The models the host advertises — what `model` may select and what the description lists. */
  readonly modelSummaries: () => readonly ModelSummary[];
  /** The named agents `role` may delegate to (ADR-0023); read per request so file edits apply immediately. */
  readonly roles?: () => readonly AgentRole[];
  /** Extensions removed from the child besides this one, e.g. `question`. */
  readonly exclude: readonly Extension[];
}): BuiltinExtension {
  const available = (): string => options.modelSummaries().map((model) => `${model.provider}/${model.modelId}`).join(", ");
  const roles = options.roles ?? (() => [] as const);

  const roleNamed = (name: string): AgentRole => {
    const found = roles().find((each) => each.name === name);
    if (found !== undefined) return found;
    const defined = roles();
    throw new Error(
      defined.length === 0
        ? "No named agents are defined"
        : `Unknown agent "${name}". Available agents: ${defined.map((each) => each.name).join(", ")}`,
    );
  };

  const tool = defineTool({
    name: "subagent",
    // Nested in a script, memo/owner bookkeeping of a child conversation would go wrong (ADR-0013 §2).
    callers: ["model"],
    description:
      "Delegate a self-contained task to a subagent that runs in its own conversation and returns its final answer. " +
      "The subagent starts with none of this conversation's context, so put everything it needs in `task`. " +
      "It works in the same files as you: subagents called in the same turn run concurrently, so give parallel subagents read-only work or non-overlapping files. " +
      "It cannot ask the user questions. `model` and `thinkingLevel` override what it inherits from you; `role` delegates to a named agent; a model or thinking level it pins cannot be overridden; `description` only labels the call. " +
      `Available models: ${available()}.`,
    parameters: Type.Object({
      task: Type.String({
        minLength: 1,
        description: "Complete, self-contained instructions. The subagent sees none of this conversation.",
      }),
      role: Type.Optional(
        Type.String({
          description:
            "Optional named agent to delegate to, from the Named agents list in your instructions. Its prompt applies, plus any model or thinking level it pins.",
        }),
      ),
      description: Type.Optional(
        Type.String({ description: 'A short 3-6 word label for the user, e.g. "Audit auth middleware".' }),
      ),
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
        // A rerun reads the facts the creation recorded, so details agree.
        const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
        if (existing !== undefined) {
          const doc = await tx.doc(SubagentDoc, existing.id);
          return {
            id: existing.id,
            ...(doc?.model === undefined ? {} : { model: doc.model }),
            ...(doc?.startedAt === undefined ? {} : { startedAt: doc.startedAt }),
          };
        }
        const role = args.role === undefined ? undefined : roleNamed(args.role);
        // A role's pins are authoritative; letting the call override them would
        // defeat pinning (ADR-0023 §5).
        if (role?.model !== undefined && args.model !== undefined) {
          throw new Error(`Agent "${role.name}" pins model ${role.model}; omit \`model\``);
        }
        if (role?.thinkingLevel !== undefined && args.thinkingLevel !== undefined) {
          throw new Error(`Agent "${role.name}" pins thinking level ${role.thinkingLevel}; omit \`thinkingLevel\``);
        }
        const modelString = role?.model ?? args.model;
        const levelString = role?.thinkingLevel ?? args.thinkingLevel;
        let model: ModelRef | undefined;
        let thinkingLevel: ModelThinkingLevel | undefined;
        let override: ReturnType<Models["getModel"]>;
        if (modelString !== undefined) {
          const slash = modelString.indexOf("/");
          const provider = slash === -1 ? "" : modelString.slice(0, slash);
          const modelId = slash === -1 ? "" : modelString.slice(slash + 1);
          override = provider === "" || modelId === "" ? undefined : options.models.getModel(provider, modelId);
          const listed = options.modelSummaries().some((each) => each.provider === provider && each.modelId === modelId);
          if (override === undefined || !listed) {
            throw new Error(
              role === undefined
                ? `Unknown model "${modelString}". Available models: ${available()}`
                : `Agent "${role.name}" uses model "${modelString}", which is not available. Available models: ${available()}`,
            );
          }
          model = { provider, modelId };
        }
        if (levelString !== undefined || override !== undefined) {
          const parent = await tx.doc(AgentDoc, api.conversationId);
          // Clamp against the model the child will run; without any model there is nothing to clamp to.
          const effective = override ?? (parent.model === undefined ? undefined : options.models.getModel(parent.model.provider, parent.model.modelId));
          if (levelString !== undefined) {
            thinkingLevel = effective === undefined ? levelString : clampThinkingLevel(effective, levelString);
          } else if (parent.thinkingLevel !== undefined) {
            // Model without a thinking level: the child keeps the caller's, clamped to the new model.
            thinkingLevel = clampThinkingLevel(override!, parent.thinkingLevel);
          }
        }
        const change: AgentChange = {
          extensions: { remove: [extension, ...options.exclude] },
          // The role's prompt is copied in at dispatch — later edits to the file do not reach this child (ADR-0023 §7).
          instructions: role === undefined || role.prompt === "" ? INSTRUCTIONS : `${INSTRUCTIONS}\n\n${role.prompt}`,
          ...(model === undefined ? {} : { model }),
          ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
        };
        const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
        await configure(tx, created.id, change);
        // The model the child will actually run: its own AgentDoc after
        // configure, else the override, else the caller's — absent for a child
        // with no model at all.
        const childAgent = await tx.doc(AgentDoc, created.id);
        const ref = childAgent.model ?? model ?? (await tx.doc(AgentDoc, api.conversationId)).model;
        const startedAt = Date.now();
        const doc = await tx.doc(SubagentDoc, created.id);
        doc.startedAt = startedAt;
        if (ref !== undefined) doc.model = `${ref.provider}/${ref.modelId}`;
        if (role !== undefined) doc.role = role.name;
        const label = args.description?.trim();
        if (label !== undefined && label !== "") doc.label = label;
        return { id: created.id, ...(ref === undefined ? {} : { model: doc.model }), startedAt };
      }, context);
      // Lets clients attach to the child while the call runs (and after, via the result details).
      await api.details(
        { conversationId: child.id, ...(child.model === undefined ? {} : { model: child.model }), ...(child.startedAt === undefined ? {} : { startedAt: child.startedAt }) },
        context,
      );
      const handle = await api.conversation(child.id, context);
      if (handle === undefined) throw new Error(`Subagent conversation ${child.id} does not exist`);
      const request = { type: "input", content: args.task, requestId: `subagent:${api.taskId}` } as const;
      const settled = await (await handle.submit(request, context)).wait(context);
      if (settled.status !== "done" || settled.type !== "input") throw new Error(`Subagent failed: ${settled.status}`);
      const answer = await api.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
      const message = answer?.model?.[0];
      // pi-ai's AssistantMessage content is always a block array, never a string.
      const text =
        message?.role === "assistant" ? message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("") : "";
      const result: ToolExecutionResult = {
        output: [{ type: "text", text: text === "" ? "(The subagent returned no text.)" : text }],
        details: {
          conversationId: child.id,
          ...(child.model === undefined ? {} : { model: child.model }),
          ...(child.startedAt === undefined ? {} : { startedAt: child.startedAt }),
        },
      };
      return result;
    },
  });

  // Declared after `tool` because execute captures it for the child's extension
  // removal; it is initialized before any call can run.
  const extension = defineExtension({
    name: "subagent",
    tools: [tool],
    sections: [
      // Rendered per request off the live store, so agent-file edits apply on
      // the next turn; the child loses this extension, so it never sees it.
      section("agent_roles", () => {
        const defined = roles();
        if (defined.length === 0) return undefined;
        return [
          "Named agents: pass one as `role` to `subagent` to delegate to it. When the user writes @name for one of these agents, delegate the relevant work to that agent with `subagent`, putting everything it needs in `task`.",
          ...defined.map((each) => `- ${each.name}: ${each.description.replace(/\s+/g, " ")}`),
        ].join("\n");
      }),
    ],
  });
  return { extension };
}
