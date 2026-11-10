// Built-in extension: one kind of subagent (ADR-0046). `subagent` creates a
// named child conversation and either waits for its answer (foreground: the
// call owns the child, so Esc cascades and the caller stays busy) or returns
// at once (background: an anchor task owns it and a reporter task delivers the
// answer back). The child is created inside the call's commit and recorded in
// the family registry under the call's task id, so a rerun after a host
// restart finds it instead of delegating twice. Afterwards subagent_send,
// subagent_stop, subagent_read, and subagent_list work on any subagent.
// The child starts as a copy of the parent's agent — same cwd, so the same
// checkout (ADR-0010 §5) — minus this extension (no recursion) and `exclude`.
import { clampThinkingLevel, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import {
  AgentDoc,
  type AgentChange,
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
import {
  answerText,
  assertCapacity,
  assertDispatchable,
  assertValidName,
  dispatch,
  entriesSince,
  familyRootIn,
  markRead,
  nameFromDescription,
  recordNamed,
  recordOf,
  statusOf,
  stopRecord,
  SubagentAnchor,
  SubagentReporter,
  SubagentsDoc,
  uniqueName,
  userMessages,
} from "../subagents.ts";

const instructions = (name: string): string =>
  `You are a subagent named "${name}", working on tasks delegated to you. You cannot ask the user questions; if you need a decision or clarification, stop and state exactly what you need in your final answer. Each final answer is returned to whoever sent the message, so make it a complete, self-contained report. You may get more messages later, from the delegating agent or from the user.`;

/** `subagent_read` returns at most this many characters, the newest. */
const READ_LIMIT = 16_000;

function contentText(content: string | readonly { type: string; text?: string }[]): string {
  return typeof content === "string" ? content : content.flatMap((block) => (block.type === "text" && block.text !== undefined ? [block.text] : [])).join("");
}

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
      "Delegate a self-contained task to a named subagent that runs in its own conversation. " +
      "Without `background` the call blocks until the subagent answers and returns its answer; with `background: true` it returns at once, you keep working, and the answer is reported to you when it arrives. " +
      "Either way the subagent stays available afterwards: continue with subagent_send, stop it with subagent_stop, see what the user said to it with subagent_read, and list subagents with subagent_list. " +
      "The subagent starts with none of this conversation's context, so put everything it needs in `task`. " +
      '`checkout` is required: "shared" works in your files (use it for read-only work; parallel subagents must not edit the same files), "worktree" gets its own Git worktree for work that edits files. ' +
      "It cannot ask the user questions. `model` and `thinkingLevel` override what it inherits from you; `role` delegates to a named agent; a model or thinking level it pins cannot be overridden. " +
      `Available models: ${available()}.`,
    parameters: Type.Object({
      task: Type.String({
        minLength: 1,
        description: "Complete, self-contained instructions. The subagent sees none of this conversation.",
      }),
      checkout: Type.Union([Type.Literal("shared"), Type.Literal("worktree")], {
        description: '"shared": your working directory. "worktree": its own Git worktree from your HEAD; uncommitted changes are not carried over.',
      }),
      name: Type.Optional(
        Type.String({
          description: 'Optional unique name, e.g. "reviewer"; derived from `description` when omitted. Use it with the other subagent tools.',
        }),
      ),
      background: Type.Optional(
        Type.Boolean({ description: "Return at once instead of waiting; the answer is reported to you when it arrives." }),
      ),
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
      if (args.checkout === "worktree") throw new Error('checkout "worktree" is not available yet; use "shared"');
      const background = args.background === true;
      const child = await api.commit(async (tx) => {
        const root = await familyRootIn(tx, api.conversationId);
        const registry = await tx.doc(SubagentsDoc, root);
        // A rerun reads the facts the creation recorded, so details agree.
        const recorded = Object.entries(registry.agents).find(([, record]) => record.createdBy === api.taskId);
        const existingId =
          recorded?.[1].conversationId ?? (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0]?.id;
        if (existingId !== undefined) {
          const doc = await tx.doc(SubagentDoc, existingId);
          return {
            id: existingId,
            name: recorded?.[0] ?? doc?.name,
            ...(doc?.model === undefined ? {} : { model: doc.model }),
            ...(doc?.startedAt === undefined ? {} : { startedAt: doc.startedAt }),
          };
        }
        const taken = (name: string): boolean => Object.hasOwn(registry.agents, name);
        let name: string;
        if (args.name !== undefined) {
          name = args.name.trim();
          assertValidName(name);
          if (taken(name)) throw new Error(`A subagent named "${name}" already exists; message it with subagent_send or pick another name`);
        } else {
          // Without a description, the task's first words name it.
          const words = args.description?.trim() || args.task.trim().split(/\s+/).slice(0, 4).join(" ");
          name = uniqueName(nameFromDescription(words), taken);
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
        await assertCapacity(tx, root);
        const change: AgentChange = {
          extensions: { remove: [extension, ...options.exclude] },
          // The role's prompt is copied in at dispatch — later edits to the file do not reach this child (ADR-0023 §7).
          instructions: role === undefined || role.prompt === "" ? instructions(name) : `${instructions(name)}\n\n${role.prompt}`,
          ...(model === undefined ? {} : { model }),
          ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
        };
        // Background: an anchor task that ends at once owns the child, so the
        // caller's Esc and idle waits never reach it (ADR-0046 §2). Foreground:
        // the call owns it, and Esc cascades to it.
        const owner = background
          ? await tx.createTask(SubagentAnchor, null, {
              ownership: { kind: "conversation" },
              conversationId: api.conversationId,
              background: true,
            })
          : api.taskId;
        const created = await tx.createConversation({ ownership: { kind: "task", taskId: owner } });
        await configure(tx, created.id, change);
        // The model the child will actually run: its own AgentDoc after
        // configure, else the override, else the caller's — absent for a child
        // with no model at all.
        const childAgent = await tx.doc(AgentDoc, created.id);
        const ref = childAgent.model ?? model ?? (await tx.doc(AgentDoc, api.conversationId)).model;
        const startedAt = Date.now();
        const doc = await tx.doc(SubagentDoc, created.id);
        doc.startedAt = startedAt;
        doc.name = name;
        doc.lifecycle = background ? "background" : "foreground";
        if (ref !== undefined) doc.model = `${ref.provider}/${ref.modelId}`;
        if (role !== undefined) doc.role = role.name;
        const label = args.description?.trim();
        if (label !== undefined && label !== "") doc.label = label;
        registry.agents[name] = {
          conversationId: created.id,
          dispatcher: api.conversationId,
          createdBy: api.taskId,
          ...(background ? {} : { call: api.taskId }),
          checkout: "shared",
          ...(label === undefined || label === "" ? {} : { description: label }),
          status: "working",
          reporters: [],
          reported: {},
        };
        if (background) {
          await dispatch(tx, { root, name, sender: api.conversationId, from: "model", message: args.task });
        }
        return { id: created.id, name, ...(ref === undefined ? {} : { model: doc.model }), startedAt };
      }, context);
      const details = {
        conversationId: child.id,
        ...(child.name === undefined ? {} : { name: child.name }),
        ...(background ? { background: true } : {}),
        ...(child.model === undefined ? {} : { model: child.model }),
        ...(child.startedAt === undefined ? {} : { startedAt: child.startedAt }),
      };
      const name = child.name ?? "subagent";
      if (background) {
        return {
          output: [
            {
              type: "text",
              text: `Started subagent "${name}" in the background. Its answer will be reported to you when it arrives; message it with subagent_send.`,
            },
          ],
          details,
        } satisfies ToolExecutionResult;
      }
      // Lets clients attach to the child while the call runs (and after, via the result details).
      await api.details(details, context);
      const handle = await api.conversation(child.id, context);
      if (handle === undefined) throw new Error(`Subagent conversation ${child.id} does not exist`);
      const request = { type: "input", content: args.task, requestId: `subagent:${api.taskId}` } as const;
      const settled = await (await handle.submit(request, context)).wait(context);
      const answered = settled.status === "done" && settled.type === "input";
      const text = await api.commit(async (tx) => {
        const found = await recordOf(tx, child.id);
        if (found !== undefined) {
          delete found.record.call;
          if (found.record.reporters.length === 0) {
            found.record.status = answered ? "idle" : settled.status === "unanswered" && settled.reason === "aborted" ? "stopped" : "failed";
          }
          // The call returns this answer; a later report of the same answer is a repeat.
          if (answered) found.record.reported[`${api.conversationId}:${settled.answer}`] = "steer";
        }
        return answered ? await answerText(tx, settled.answer) : undefined;
      }, context);
      if (text === undefined) throw new Error(`Subagent failed: ${settled.status === "unanswered" ? settled.reason : settled.status}`);
      return {
        output: [{ type: "text", text: `[subagent ${name} answered]\n\n${text}` }],
        details,
      } satisfies ToolExecutionResult;
    },
  });

  const send = defineTool({
    name: "subagent_send",
    callers: ["model"],
    description:
      "Send a message to one of your subagents (started with `subagent`), for example a follow-up question or new instructions. Returns at once; its answer is reported to you when it arrives. A message to a subagent that is still working steers its current answer.",
    parameters: Type.Object({
      name: Type.String({ description: "The subagent's name." }),
      message: Type.String({ minLength: 1, description: "Self-contained message; it sees only its own conversation." }),
    }),
    // Not rerun after a restart: the model sees the interrupted call and can check with subagent_list.
    replay: "unsafe",
    execute: async (args, api, context) => {
      const conversationId = await api.commit(async (tx) => {
        const root = await familyRootIn(tx, api.conversationId);
        const record = await assertDispatchable(tx, root, args.name);
        await dispatch(tx, { root, name: args.name, sender: api.conversationId, from: "model", message: args.message });
        return record.conversationId;
      }, context);
      return {
        output: [{ type: "text", text: `Sent to subagent "${args.name}". Its answer will be reported to you when it arrives.` }],
        details: { conversationId, name: args.name },
      } satisfies ToolExecutionResult;
    },
  });

  const stop = defineTool({
    name: "subagent_stop",
    callers: ["model"],
    description: "Stop what one of your subagents is doing now and drop its queued messages. It stays available for subagent_send.",
    parameters: Type.Object({ name: Type.String({ description: "The subagent's name." }) }),
    // Rerunning a stop after a restart could stop newer work.
    replay: "unsafe",
    execute: async (args, api, context) => {
      const conversationId = await api.commit(async (tx) => {
        const root = await familyRootIn(tx, api.conversationId);
        const record = recordNamed((await tx.doc(SubagentsDoc, root)).agents, args.name);
        stopRecord(record, "model");
        return record.conversationId;
      }, context);
      const handle = await api.conversation(conversationId, context);
      if (handle === undefined) throw new Error(`Subagent conversation ${conversationId} does not exist`);
      await handle.abort(context);
      return {
        output: [{ type: "text", text: `Stopped subagent "${args.name}". It keeps its conversation; message it again with subagent_send.` }],
        details: { conversationId, name: args.name },
      } satisfies ToolExecutionResult;
    },
  });

  const read = defineTool({
    name: "subagent_read",
    callers: ["model"],
    description:
      "Read what was said in one of your subagents' conversations since you last read it — the user may talk to subagents directly. Returns the messages and answers, without tool calls.",
    parameters: Type.Object({ name: Type.String({ description: "The subagent's name." }) }),
    // Each read advances the cursor; a rerun would return nothing new.
    replay: "unsafe",
    execute: async (args, api, context) => {
      const text = await api.commit(async (tx) => {
        const root = await familyRootIn(tx, api.conversationId);
        const record = recordNamed((await tx.doc(SubagentsDoc, root)).agents, args.name);
        const entries = await entriesSince(tx, record);
        const fromUser = (await userMessages(tx, record)).entries;
        const lines: string[] = [];
        for (const entry of entries) {
          const message = entry.model?.[0];
          if (entry.kind === "pi.user" && message?.role === "user") {
            lines.push(`${fromUser.has(entry.id) ? "User" : "Delegated"}: ${contentText(message.content)}`);
          } else if (entry.kind === "pi.assistant" && message?.role === "assistant") {
            const said = contentText(message.content);
            if (said !== "") lines.push(`${args.name}: ${said}`);
          }
        }
        const last = entries.at(-1);
        if (last !== undefined) await markRead(tx, record, last.id);
        if (lines.length === 0) return `Nothing new in subagent "${args.name}" since you last read it.`;
        const joined = lines.join("\n\n");
        return joined.length <= READ_LIMIT ? joined : `(Earlier messages omitted.)\n\n${joined.slice(-READ_LIMIT)}`;
      }, context);
      return { output: [{ type: "text", text }] } satisfies ToolExecutionResult;
    },
  });

  const list = defineTool({
    name: "subagent_list",
    callers: ["model"],
    description: "List the subagents of this conversation with their status: working, idle, stopped, or failed.",
    parameters: Type.Object({}),
    replay: "safe",
    execute: async (_args, api, context) => {
      const text = await api.commit(async (tx) => {
        const root = await familyRootIn(tx, api.conversationId);
        const lines: string[] = [];
        for (const [name, record] of Object.entries((await tx.doc(SubagentsDoc, root)).agents)) {
          const label = record.description === undefined ? "" : ` — ${record.description}`;
          lines.push(`- ${name}: ${await statusOf(tx, record)}${label} (checkout: ${record.checkout})`);
        }
        return lines.length === 0 ? "No subagents." : lines.join("\n");
      }, context);
      return { output: [{ type: "text", text }] } satisfies ToolExecutionResult;
    },
  });

  // Declared after `tool` because execute captures it for the child's extension
  // removal; it is initialized before any call can run.
  const extension = defineExtension({
    name: "subagent",
    tools: [tool, send, stop, read, list],
    // Installed with the tools, so reporters resume after a restart.
    tasks: [SubagentAnchor, SubagentReporter],
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
