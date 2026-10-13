// Auto-title and manual rename: the title lives in the conversation's
// pinomad.title doc, and the summary serves it over the first-message fallback.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId, JsonObject } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { isBusy, transcript } from "@pinomad/protocol/transcript.ts";
import type { ConversationNode } from "@pinomad/protocol/organization.ts";
import type { DurableView, ConversationSummary, ModelSummary } from "@pinomad/protocol/view.ts";
import { cleanTitle } from "../src/auto-title.ts";
import { createSubagent } from "../src/extensions/subagent.ts";
import { connectTo, startChat, startFauxHost, useCleanups, waitForView } from "./support.ts";

const defer = useCleanups();
const context = BACKGROUND_CONTEXT;

/** Every node in an organized view, top-level and nested. */
const allSummaries = (view: DurableView): ConversationSummary[] => {
  const flat = (nodes: readonly ConversationNode[]): ConversationSummary[] =>
    nodes.flatMap((node) => [node.summary, ...flat(node.children)]);
  return flat(view.organized.chats.concat(...view.organized.projects.map((entry) => entry.conversations)));
};
const summaryOf = (view: DurableView, id: ConversationId): ConversationSummary | undefined =>
  allSummaries(view).find((summary) => summary.id === id);

const delegates = (args: JsonObject) => fauxAssistantMessage(fauxToolCall("subagent", args), { stopReason: "toolUse" });

describe("cleanTitle", () => {
  it.each([
    ["Fix login bug", "Fix login bug"],
    ['"Fix login bug"', "Fix login bug"],
    ["`Fix login bug`", "Fix login bug"],
    ["Title: Fix login bug.", "Fix login bug"],
    ["title: Fix login bug", "Fix login bug"],
    ["Fix login bug\n\nHere is what I did…", "Fix login bug"],
    ["\n\n  Fix   login   bug  \n", "Fix login bug"],
    ["「修复登录错误」。", "修复登录错误"],
    ["“Refactor auth module”", "Refactor auth module"],
    ["Just a title!", "Just a title"],
  ])("cleans %j", (raw, expected) => {
    expect(cleanTitle(raw)).toBe(expected);
  });

  it("returns undefined for whitespace-only and punctuated-empty output", () => {
    expect(cleanTitle("   \n \n")).toBeUndefined();
    expect(cleanTitle("Title:")).toBeUndefined();
    expect(cleanTitle('"。"')).toBeUndefined();
  });

  it("caps the title at 80 characters", () => {
    const long = "word ".repeat(30).trim();
    const cleaned = cleanTitle(long)!;
    expect(cleaned.length).toBeLessThanOrEqual(80);
    expect(cleaned).toBe("word ".repeat(16).trim());
  });
});

describe("auto-title", () => {
  it("titles a conversation after its first successful run, and never again", async () => {
    const host = await startFauxHost(defer, { autoTitle: true, answers: ["done", "Fix login bug", "second answer"] });
    const client = await connectTo(defer, host);
    const id = await startChat(client, "the login page crashes");
    await waitForView(client.view, (view) => summaryOf(view, id)?.title === "Fix login bug");

    // A second run does not re-title: the next queued answer is the run's own.
    await client.controller.submit("follow up", "followUp");
    await waitForView(
      client.view,
      (view) => !isBusy(view.conversation!) && transcript(view.conversation!).at(-1)?.text === "second answer",
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(summaryOf(client.view.current(), id)?.title).toBe("Fix login bug");
  });

  it("skips a failed first run and titles after the next successful one", async () => {
    const host = await startFauxHost(defer, {
      autoTitle: true,
      answers: [fauxAssistantMessage("boom", { errorMessage: "provider blew up", stopReason: "error" }), "recovered", "Named it"],
    });
    const client = await connectTo(defer, host);
    const id = await startChat(client, "try it");
    await waitForView(client.view, (view) => summaryOf(view, id)?.status === "failed");
    // The failure wrote nothing; the fallback title still shows.
    expect(summaryOf(client.view.current(), id)?.title).toBe("try it");

    await client.controller.submit("again", "followUp");
    await waitForView(client.view, (view) => transcript(view.conversation!).at(-1)?.text === "recovered");
    await waitForView(client.view, (view) => summaryOf(view, id)?.title === "Named it");
  });

  it("keeps a manual rename over the generated title and never regenerates", async () => {
    const host = await startFauxHost(defer, { autoTitle: true, answers: ["done", "Auto name", "second answer"] });
    const client = await connectTo(defer, host);
    const id = await startChat(client, "first");
    await waitForView(client.view, (view) => summaryOf(view, id)?.title === "Auto name");

    await client.controller.renameConversation(id, "Mine");
    await waitForView(client.view, (view) => summaryOf(view, id)?.title === "Mine");
  });

  it("a manual rename while untitled survives the successful retry that follows", async () => {
    const host = await startFauxHost(defer, {
      autoTitle: true,
      answers: [fauxAssistantMessage("boom", { errorMessage: "x", stopReason: "error" }), "recovered", "Would-be title"],
    });
    const client = await connectTo(defer, host);
    const id = await startChat(client, "try it");
    await waitForView(client.view, (view) => summaryOf(view, id)?.status === "failed");

    await client.controller.renameConversation(id, "Custom name");
    await waitForView(client.view, (view) => summaryOf(view, id)?.title === "Custom name");

    await client.controller.submit("again", "followUp");
    await waitForView(client.view, (view) => transcript(view.conversation!).at(-1)?.text === "recovered");
    // The retry's run end must not call the model: "Would-be title" stays unused.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(summaryOf(client.view.current(), id)?.title).toBe("Custom name");
  });

  it("rejects an empty, an over-long, and a subagent rename", async () => {
    const host = await startFauxHost(defer, {
      extensions: ({ models, modelSummaries }: { models: Models; modelSummaries: () => readonly ModelSummary[] }) => [
        createSubagent({ models, modelSummaries, exclude: [] }),
      ],
      answers: [delegates({ task: "count the lines" }), "child answer", "parent final"],
    });
    const client = await connectTo(defer, host);
    const id = await startChat(client, "delegate");
    await waitForView(
      client.view,
      (view) => !isBusy(view.conversation!) && transcript(view.conversation!).at(-1)?.text === "parent final",
    );
    const child = summaryOf(client.view.current(), id) && allSummaries(client.view.current()).find((s) => s.kind === "subagent");

    await expect(client.controller.renameConversation(id, "   ")).rejects.toThrow("Title cannot be empty");
    await expect(client.controller.renameConversation(id, "x".repeat(201))).rejects.toThrow(/too long/i);
    await expect(client.controller.renameConversation(child!.id, "nope")).rejects.toThrow(
      "Subagent conversations are named by the call that started them",
    );
    // Nothing was written.
    expect(summaryOf(client.view.current(), id)?.title).toBe("delegate");
  });

  it("a fork does not inherit the parent's title and titles after its own first run", async () => {
    let release!: (title: string) => void;
    const gate = new Promise<string>((resolve) => (release = resolve));
    const heldTitle: FauxResponseFactory = () => gate.then((text) => fauxAssistantMessage(text));
    const host = await startFauxHost(defer, {
      autoTitle: true,
      answers: ["parent done", "Parent Title", "fork answer", heldTitle],
    });
    const client = await connectTo(defer, host);
    const parentId = await startChat(client, "parent work");
    await waitForView(client.view, (view) => summaryOf(view, parentId)?.title === "Parent Title");

    const at = client.view.current().conversation!.entries.at(-1)!.id;
    const forkId = await host.harness.commit(
      async (tx) => (await tx.forkConversation(parentId, at, { ownership: { kind: "ownerless" } })).id,
      context,
    );
    await waitForView(client.view, (view) => summaryOf(view, forkId) !== undefined);
    // fork: "initial" on TitleDoc — nothing inherited, and no own message yet.
    expect(summaryOf(client.view.current(), forkId)?.title).toBeUndefined();

    await client.controller.submit("fork work", "followUp", forkId);
    // The fork's own first message becomes the fallback title while its run ends.
    await waitForView(client.view, (view) => summaryOf(view, forkId)?.title === "fork work");
    release("Fork Title");
    await waitForView(client.view, (view) => summaryOf(view, forkId)?.title === "Fork Title");
    expect(summaryOf(client.view.current(), parentId)?.title).toBe("Parent Title");
  });
});
