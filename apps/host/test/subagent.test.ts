import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { AgentDoc, type ConversationId, type ConversationView, type JsonObject } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { isBusy, streamingText, transcript } from "@pinomad/protocol/transcript.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import type { ModelSummary } from "@pinomad/protocol/view.ts";
import { question } from "../src/extensions/question.ts";
import { createSubagent } from "../src/extensions/subagent.ts";
import { connectTo, freePort, LONG_ANSWER, startChat, startFauxHost, tempDir, useCleanups, waitForView } from "./support.ts";
import type { OpenedHost } from "../src/host.ts";

const defer = useCleanups();
const context = BACKGROUND_CONTEXT;

const extensions = (provided: { models: Models; modelSummaries: () => readonly ModelSummary[] }) => [
  question,
  createSubagent({ models: provided.models, modelSummaries: provided.modelSummaries, exclude: [question.extension] }),
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
    expect(result.details).toEqual({ conversationId: child!.id });
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
    expect(isBusy(client.view.current().conversation!)).toBe(false);
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
  });
});
