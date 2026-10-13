import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import { AgentDoc, type ConversationId, type ConversationView, type JsonObject, LiveDoc } from "@earendil-works/pi-durable";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { isBusy, streamingText, transcript } from "@pinomad/protocol/transcript.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import type { ModelSummary } from "@pinomad/protocol/view.ts";
import type { AgentRoleStore } from "../src/agent-roles.ts";
import { question } from "../src/extensions/question.ts";
import { createSubagent } from "../src/extensions/subagent.ts";
import { connectTo, freePort, LONG_ANSWER, startChat, startFauxHost, tempDir, useCleanups, waitForView } from "./support.ts";
import type { OpenedHost } from "../src/host.ts";

const defer = useCleanups();
const context = BACKGROUND_CONTEXT;

const extensions = (provided: {
  models: Models;
  modelSummaries: () => readonly ModelSummary[];
  agentRoles: AgentRoleStore;
}) => [
  question,
  createSubagent({
    models: provided.models,
    modelSummaries: provided.modelSummaries,
    roles: () => provided.agentRoles.value.roles,
    exclude: [question.extension],
  }),
];

const delegates = (args: JsonObject) => fauxAssistantMessage(fauxToolCall("subagent", args), { stopReason: "toolUse" });

/** The parent's subagent child once the organized list shows one. */
async function childIdOf(client: RemoteDurable): Promise<ConversationId> {
  await waitForView(client.view, (view) => view.organized.chats.some((node) => node.children.length > 0));
  return client.view.current().organized.chats.flatMap((node) => node.children)[0]!.summary.id;
}

/** A committed snapshot of a conversation's view. */
async function viewOf(host: OpenedHost, id: ConversationId): Promise<ConversationView> {
  const conversation = (await host.harness.conversation(id, context))!;
  const watch = await conversation.watch(context);
  try {
    return watch.value;
  } finally {
    await watch.stop();
  }
}

/** Resolve with the first conversation view matching `predicate`. */
async function watchUntil(
  host: OpenedHost,
  id: ConversationId,
  predicate: (view: ConversationView) => boolean,
  timeoutMs = 20_000,
): Promise<ConversationView> {
  const conversation = (await host.harness.conversation(id, context))!;
  const watch = await conversation.watch(context);
  try {
    return await new Promise<ConversationView>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`conversation ${id} condition not met within ${timeoutMs} ms`)), timeoutMs);
      const check = (value: ConversationView): void => {
        if (!predicate(value)) return;
        clearTimeout(timer);
        resolve(value);
      };
      check(watch.value);
      watch.start(async (value) => check(value));
    });
  } finally {
    await watch.stop();
  }
}

type ToolResultMessageLike = {
  content?: readonly { type: string; text?: string }[];
  isError?: boolean;
  details?: unknown;
};

function toolResult(view: ConversationView): ToolResultMessageLike {
  const entry = view.entries.find((candidate) => candidate.kind === "pi.tool-result");
  return entry?.model?.[0] as ToolResultMessageLike;
}

function resultText(message: ToolResultMessageLike): string {
  return (message.content ?? []).flatMap((block) => (block.type === "text" && block.text !== undefined ? [block.text] : [])).join("");
}

describe("subagent tool", () => {
  it("runs the task in an owned child conversation and returns its answer", async () => {
    const host = await startFauxHost(defer, {
      extensions,
      answers: [delegates({ task: "count the lines" }), "child answer", "parent final"],
    });
    const client = await connectTo(defer, host);
    const parentId = await startChat(client, "delegate");
    await waitForView(client.view, (view) => !isBusy(view.conversation!) && transcript(view.conversation!).at(-1)?.text === "parent final");

    const child = client.view.current().organized.chats.find((node) => node.summary.id === parentId)?.children[0]?.summary;
    expect(child).toMatchObject({ kind: "subagent", parent: parentId, title: "count the lines" });

    expect(transcript(await viewOf(host, child!.id))).toEqual([
      { role: "user", text: "count the lines" },
      { role: "assistant", text: "child answer", stopReason: "stop" },
    ]);

    const result = toolResult(client.view.current().conversation!);
    expect(result.isError).not.toBe(true);
    expect(resultText(result)).toBe("child answer");
    // Model and start time ride the details so clients can label the card.
    const details = result.details as { conversationId: number; model?: string; startedAt?: number };
    expect(details.conversationId).toBe(child!.id);
    const shown = client.view.current().models[0]!;
    expect(details.model).toBe(`${shown.provider}/${shown.modelId}`);
    expect(typeof details.startedAt).toBe("number");
  });

  it("reports an explicit child model and its start time in details and the live slot", async () => {
    let finishChild!: (message: ReturnType<typeof fauxAssistantMessage>) => void;
    const childGate = new Promise<ReturnType<typeof fauxAssistantMessage>>((resolve) => (finishChild = resolve));
    const host = await startFauxHost(defer, {
      extensions,
      fauxModels: [
        { id: "faux-1", name: "Faux Model" },
        { id: "faux-thinker", name: "Faux Thinker", reasoning: true },
      ],
      answers: [delegates({ task: "count the lines", model: "faux/faux-thinker" }), () => childGate, "parent final"],
    });
    const client = await connectTo(defer, host);
    const parentId = await startChat(client, "delegate");
    const childId = await childIdOf(client);

    // While the call runs, the live slot carries the same details clients will
    // read off the settled tool result.
    const live = await host.harness.snapshot(LiveDoc, parentId, context);
    const slot = live?.tools?.find((candidate) => candidate.name === "subagent" && candidate.status === "running");
    expect(slot).not.toBeUndefined();
    const liveDetails = slot!.details as { model?: string; startedAt?: number };
    expect(liveDetails.model).toBe("faux/faux-thinker");
    expect(typeof liveDetails.startedAt).toBe("number");

    finishChild(fauxAssistantMessage("child answer"));
    await waitForView(client.view, (view) => !isBusy(view.conversation!) && transcript(view.conversation!).at(-1)?.text === "parent final");
    const details = toolResult(client.view.current().conversation!).details as { model?: string; startedAt?: number };
    expect(details).toEqual({ conversationId: childId, model: "faux/faux-thinker", startedAt: liveDetails.startedAt });
  });

  it("labels the child with the trimmed description the delegating agent gave", async () => {
    const dir = await tempDir();
    defer(dir.remove);
    const host = await startFauxHost(defer, {
      dataDir: dir.path,
      extensions,
      answers: [
        delegates({ task: "count the lines", description: "  Audit auth middleware  " }),
        "child answer",
        "parent final",
        delegates({ task: "look around" }),
        "second child answer",
        "parent final again",
      ],
    });
    const client = await connectTo(defer, host);
    await startChat(client, "delegate");
    await waitForView(client.view, (view) => !isBusy(view.conversation!) && transcript(view.conversation!).at(-1)?.text === "parent final");

    const childrenOf = (view: ReturnType<typeof client.view.current>) =>
      view.organized.chats.flatMap((node) => node.children).map((node) => node.summary);
    expect(childrenOf(client.view.current())[0]).toMatchObject({ kind: "subagent", label: "Audit auth middleware" });

    // A call without `description` leaves the label off the summary.
    await client.controller.submit("delegate again", "followUp");
    await waitForView(
      client.view,
      (view) => !isBusy(view.conversation!) && transcript(view.conversation!).at(-1)?.text === "parent final again",
    );
    expect(childrenOf(client.view.current())[1]).toMatchObject({ kind: "subagent" });
    expect(childrenOf(client.view.current())[1]!.label).toBeUndefined();

    // The labels persist through a host restart — the doc is read at open.
    const before = childrenOf(client.view.current());
    const dataDir = client.view.current().session.directory;
    client.close();
    await host.close();
    const second = await startFauxHost(defer, { dataDir });
    const after = await connectTo(defer, second);
    await waitForView(after.view, (view) => view.organized.chats.some((node) => node.children.length === 2));
    expect(childrenOf(after.view.current()).map((summary) => summary.label)).toEqual(before.map((summary) => summary.label));
  });

  it("configures the child without subagent or question and with subagent instructions", async () => {
    const host = await startFauxHost(defer, {
      extensions,
      answers: [delegates({ task: "look around" }), "child answer", "parent final"],
    });
    const client = await connectTo(defer, host);
    await startChat(client, "delegate");
    const childId = await childIdOf(client);
    await waitForView(client.view, (view) => !isBusy(view.conversation!));

    const state = await host.harness.snapshot(AgentDoc, childId, context);
    // With ask_user_question gone, the child must be told to report open questions instead.
    expect(state?.instructions).toContain("cannot ask the user");
    const agent = await (await host.harness.conversation(childId, context))!.agent(context);
    expect(agent.extensions.map((extension) => extension.name)).not.toContain("subagent");
    expect(agent.extensions.map((extension) => extension.name)).not.toContain("question");
    expect(agent.tools.map((tool) => tool.name)).not.toContain("subagent");
    expect(agent.tools.map((tool) => tool.name)).not.toContain("ask_user_question");
  });

  it("rejects an unknown model without creating a child, listing what is available", async () => {
    const host = await startFauxHost(defer, {
      extensions,
      answers: [delegates({ task: "go", model: "faux/nonexistent" }), "parent recovered"],
    });
    const client = await connectTo(defer, host);
    await startChat(client, "delegate");
    await waitForView(
      client.view,
      (view) => !isBusy(view.conversation!) && transcript(view.conversation!).at(-1)?.text === "parent recovered",
    );

    const result = toolResult(client.view.current().conversation!);
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('Unknown model "faux/nonexistent"');
    expect(resultText(result)).toContain("faux/faux-1");
    // No conversation is owned by a task: the only conversation is the parent itself.
    const conversations = await host.harness.commit((tx) => tx.scanConversations({}, 256), context);
    expect(client.view.current().organized.chats[0]!.children).toEqual([]);
    expect(conversations.items.filter((record) => record.owner !== undefined)).toEqual([]);
  });

  it("configures a valid model override with the thinking level clamped to it", async () => {
    const host = await startFauxHost(defer, {
      extensions,
      fauxModels: [
        { id: "faux-1", name: "Faux Model" },
        { id: "faux-thinker", name: "Faux Thinker", reasoning: true },
      ],
      answers: [delegates({ task: "go", model: "faux/faux-thinker", thinkingLevel: "xhigh" }), "child answer", "parent final"],
    });
    const client = await connectTo(defer, host);
    await startChat(client, "delegate");
    const childId = await childIdOf(client);
    await waitForView(client.view, (view) => !isBusy(view.conversation!));

    const state = await host.harness.snapshot(AgentDoc, childId, context);
    expect(state?.model).toEqual({ provider: "faux", modelId: "faux-thinker" });
    // faux-thinker reasons but maps no xhigh/max: xhigh clamps down to high.
    expect(state?.thinkingLevel).toBe("high");
  });

  it("aborting the parent aborts the child mid-generation and leaves both idle", async () => {
    const host = await startFauxHost(defer, {
      extensions,
      tokensPerSecond: 4,
      answers: [delegates({ task: "write a long report" }), LONG_ANSWER, "parent final"],
    });
    const client = await connectTo(defer, host);
    const parentId = await startChat(client, "delegate");
    const childId = await childIdOf(client);
    const child = (await host.harness.conversation(childId, context))!;

    await watchUntil(host, childId, (view) => (streamingText(view)?.length ?? 0) > 0);
    await client.controller.abort();

    await child.waitForIdle(context);
    const view = await viewOf(host, childId);
    expect(isBusy(view)).toBe(false);
    // The client's view of the parent is a remote snapshot; its abort settles on its own schedule.
    await waitForView(client.view, (current) => !isBusy(current.conversation!));
    expect(transcript(view).at(-1)).toMatchObject({ role: "assistant", stopReason: "aborted" });
    expect((transcript(view).at(-1)?.text.length ?? 0)).toBeLessThan(LONG_ANSWER.length);
    expect(client.view.current().conversation!.conversation.id).toBe(parentId);
  });

  it("reuses the child after a host restart instead of creating a second one", async () => {
    const dir = await tempDir();
    defer(dir.remove);
    const port = await freePort();
    const first = await startFauxHost(defer, {
      dataDir: dir.path,
      port,
      extensions,
      tokensPerSecond: 4,
      answers: [delegates({ task: "write a long report" }), LONG_ANSWER, "parent final v1"],
    });
    const client = await connectTo(defer, first);
    const parentId = await startChat(client, "delegate");
    const childId = await childIdOf(client);
    // The child is mid-generation: its run will resume when the host reopens.
    const liveState = await first.harness.snapshot(LiveDoc, parentId, context);
    const firstStartedAt = (liveState?.tools?.[0]?.details as { startedAt?: number } | undefined)?.startedAt;
    // The equality check below proves nothing if the slot carried no details.
    expect(typeof firstStartedAt).toBe("number");
    await watchUntil(first, childId, (view) => (streamingText(view)?.length ?? 0) > 0);
    // openHost.close() writes no outcome, so the turn resumes on the next open.
    await first.close();

    const second = await startFauxHost(defer, {
      dataDir: dir.path,
      port,
      extensions,
      answers: ["child answer after restart", "parent final"],
    });
    await waitForView(client.view, (view) => view.connection === "connected");
    await waitForView(
      client.view,
      (view) => !isBusy(view.conversation!) && transcript(view.conversation!).at(-1)?.text === "parent final",
      30_000,
    );

    const owned = await second.harness.commit(async (tx) => {
      const page = await tx.scanConversations({}, 256);
      return page.items.filter((record) => record.owner !== undefined);
    }, context);
    expect(owned.map((record) => record.id)).toEqual([childId]);

    expect(transcript(await viewOf(second, childId)).at(-1)).toMatchObject({
      role: "assistant",
      text: "child answer after restart",
      stopReason: "stop",
    });
    const result = toolResult(client.view.current().conversation!);
    expect(result.isError).not.toBe(true);
    expect(resultText(result)).toBe("child answer after restart");
    // A rerun after restart reports the same start time the creation recorded.
    expect((result.details as { startedAt?: number }).startedAt).toBe(firstStartedAt);
  });
});

describe("subagent with a named agent", () => {
  const REVIEWER = '---\ndescription: "Reviews code"\nmodel: "faux/faux-thinker"\nthinkingLevel: "high"\n---\n\nBe strict.\n';
  const PINNED = { task: "review this", role: "reviewer" };

  /** A host whose data dir carries the given agent files. */
  async function hostWithRoles(files: Record<string, string>, options: Parameters<typeof startFauxHost>[1] & { answers: readonly (string | FauxResponseStep)[] }) {
    const dir = await tempDir();
    defer(dir.remove);
    await mkdir(join(dir.path, "agents"), { recursive: true });
    for (const [file, text] of Object.entries(files)) await writeFile(join(dir.path, "agents", file), text);
    const host = await startFauxHost(defer, { ...options, dataDir: dir.path });
    return { host, dir };
  }

  it("pins the role's model and thinking level and appends its prompt to the instructions", async () => {
    const { host } = await hostWithRoles(
      { "reviewer.md": REVIEWER },
      {
        extensions,
        fauxModels: [
          { id: "faux-1", name: "Faux Model" },
          { id: "faux-thinker", name: "Faux Thinker", reasoning: true },
        ],
        answers: [delegates(PINNED), "child answer", "parent final"],
      },
    );
    const client = await connectTo(defer, host);
    await startChat(client, "delegate");
    const childId = await childIdOf(client);
    await waitForView(client.view, (view) => !isBusy(view.conversation!));

    const state = await host.harness.snapshot(AgentDoc, childId, context);
    expect(state?.model).toEqual({ provider: "faux", modelId: "faux-thinker" });
    expect(state?.thinkingLevel).toBe("high");
    expect(state?.instructions).toBe(`You are a subagent working on one delegated task. You cannot ask the user questions; if you need a decision or clarification, stop and state exactly what you need in your final answer. Your final message is returned to the delegating agent as the result, so make it a complete, self-contained report.\n\nBe strict.`);

    // The summary names the agent the child ran as.
    const child = client.view.current().organized.chats.flatMap((node) => node.children)[0]?.summary;
    expect(child?.role).toBe("reviewer");
  });

  it("rejects a model arg on a pinned role and a thinkingLevel arg on a pinned level", async () => {
    const { host } = await hostWithRoles(
      { "reviewer.md": REVIEWER },
      {
        extensions,
        fauxModels: [
          { id: "faux-1", name: "Faux Model" },
          { id: "faux-thinker", name: "Faux Thinker", reasoning: true },
        ],
        answers: [
          delegates({ ...PINNED, model: "faux/faux-1" }),
          delegates({ ...PINNED, thinkingLevel: "low" }),
          "parent final",
        ],
      },
    );
    const client = await connectTo(defer, host);
    await startChat(client, "delegate");
    await waitForView(client.view, (view) => !isBusy(view.conversation!) && transcript(view.conversation!).at(-1)?.text === "parent final");

    const errors = (client.view.current().conversation!.entries ?? [])
      .filter((entry) => entry.kind === "pi.tool-result")
      .map((entry) => resultText(entry.model?.[0] as ToolResultMessageLike));
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain('pins model faux/faux-thinker; omit `model`');
    expect(errors[1]).toContain('pins thinking level high; omit `thinkingLevel`');
    // Neither rejected call created a child.
    expect(client.view.current().organized.chats[0]!.children).toEqual([]);
  });

  it("allows explicit overrides on an unpinned role", async () => {
    const { host } = await hostWithRoles(
      { "loose.md": '---\ndescription: "No pins"\n---\n\nNo pins.\n' },
      {
        extensions,
        fauxModels: [
          { id: "faux-1", name: "Faux Model" },
          { id: "faux-thinker", name: "Faux Thinker", reasoning: true },
        ],
        answers: [delegates({ task: "go", role: "loose", model: "faux/faux-thinker", thinkingLevel: "low" }), "child answer", "parent final"],
      },
    );
    const client = await connectTo(defer, host);
    await startChat(client, "delegate");
    const childId = await childIdOf(client);
    await waitForView(client.view, (view) => !isBusy(view.conversation!));
    const state = await host.harness.snapshot(AgentDoc, childId, context);
    expect(state?.model).toEqual({ provider: "faux", modelId: "faux-thinker" });
    expect(state?.thinkingLevel).toBe("low");
  });

  it("rejects an unknown role listing the defined names", async () => {
    const { host } = await hostWithRoles(
      { "reviewer.md": REVIEWER },
      { extensions, answers: [delegates({ task: "go", role: "ghost" }), "parent final"] },
    );
    const client = await connectTo(defer, host);
    await startChat(client, "delegate");
    await waitForView(client.view, (view) => !isBusy(view.conversation!) && transcript(view.conversation!).at(-1)?.text === "parent final");
    const result = toolResult(client.view.current().conversation!);
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('Unknown agent "ghost"');
    expect(resultText(result)).toContain("reviewer");
  });

  it("rejects a role whose pinned model is not available", async () => {
    const { host } = await hostWithRoles(
      { "reviewer.md": REVIEWER },
      { extensions, answers: [delegates(PINNED), "parent final"] },
    );
    const client = await connectTo(defer, host);
    await startChat(client, "delegate");
    await waitForView(client.view, (view) => !isBusy(view.conversation!) && transcript(view.conversation!).at(-1)?.text === "parent final");
    const result = toolResult(client.view.current().conversation!);
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('Agent "reviewer" uses model "faux/faux-thinker", which is not available');
  });

  it("keeps the child's pinned agent after the role file changes mid-run", async () => {
    let finishChild!: (message: ReturnType<typeof fauxAssistantMessage>) => void;
    const { host, dir } = await hostWithRoles(
      { "reviewer.md": REVIEWER },
      {
        extensions,
        fauxModels: [
          { id: "faux-1", name: "Faux Model" },
          { id: "faux-thinker", name: "Faux Thinker", reasoning: true },
        ],
        answers: [delegates(PINNED), () => new Promise<ReturnType<typeof fauxAssistantMessage>>((resolve) => (finishChild = resolve)), "parent final"],
      },
    );
    const client = await connectTo(defer, host);
    await startChat(client, "delegate");
    const childId = await childIdOf(client);

    // Rewriting and then deleting the file mid-run must not touch the dispatched child.
    await writeFile(join(dir.path, "agents", "reviewer.md"), '---\ndescription: "Edited"\n---\n\nDifferent prompt.\n');
    await writeFile(join(dir.path, "agents", "deleted.md"), REVIEWER);
    const gone = join(dir.path, "agents", "deleted.md");
    await writeFile(gone, REVIEWER);
    const { rm } = await import("node:fs/promises");
    await rm(gone);

    finishChild(fauxAssistantMessage("child answer"));
    await waitForView(client.view, (view) => !isBusy(view.conversation!) && transcript(view.conversation!).at(-1)?.text === "parent final");
    const state = await host.harness.snapshot(AgentDoc, childId, context);
    expect(state?.model).toEqual({ provider: "faux", modelId: "faux-thinker" });
    expect(state?.thinkingLevel).toBe("high");
    expect(state?.instructions).toContain("Be strict.");
    expect(state?.instructions).not.toContain("Different prompt");
  });

  it("shows the agent_roles section in the parent's prompt but never the child's", async () => {
    const prompts: string[] = [];
    const { host } = await hostWithRoles(
      { "reviewer.md": REVIEWER, "planner.md": '---\ndescription: "Plans work"\n---\n\nPlan it.\n' },
      {
        extensions,
        answers: [
          (context) => {
            prompts.push(getCurrentSystemPrompt(context.messages));
            return delegates({ task: "go", role: "planner" });
          },
          (context) => {
            prompts.push(getCurrentSystemPrompt(context.messages));
            return fauxAssistantMessage("child answer");
          },
          (context) => {
            prompts.push(getCurrentSystemPrompt(context.messages));
            return fauxAssistantMessage("parent final");
          },
        ],
      },
    );
    const client = await connectTo(defer, host);
    await startChat(client, "delegate");
    await waitForView(client.view, (view) => !isBusy(view.conversation!) && transcript(view.conversation!).at(-1)?.text === "parent final");

    expect(prompts).toHaveLength(3);
    // Parent requests carry the section with every defined role; the child, whose
    // subagent extension was removed, never sees it.
    for (const parent of [prompts[0]!, prompts[2]!]) {
      expect(parent).toContain("agent_roles");
      expect(parent).toContain("- reviewer: Reviews code");
      expect(parent).toContain("- planner: Plans work");
    }
    expect(prompts[1]).not.toContain("agent_roles");
    expect(prompts[1]).toContain("Plan it."); // the role's prompt rides instructions instead
  });

  it("omits the section when no roles are defined", async () => {
    const prompts: string[] = [];
    const host = await startFauxHost(defer, {
      extensions,
      answers: [
        (context) => {
          prompts.push(getCurrentSystemPrompt(context.messages));
          return fauxAssistantMessage("done");
        },
      ],
    });
    const client = await connectTo(defer, host);
    await startChat(client, "hi");
    await waitForView(client.view, (view) => !isBusy(view.conversation!));
    expect(prompts[0]).not.toContain("agent_roles");
  });
});
