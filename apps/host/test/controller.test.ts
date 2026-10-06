import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AgentDoc, type ConversationId } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { isBusy, streamingText, transcript } from "@pinomad/protocol/transcript.ts";
import { connectTo, LONG_ANSWER, startChat, startFauxHost, useCleanups, waitForView } from "./support.ts";

const defer = useCleanups();
const inboxOf = (view: { conversation?: { docs: Record<string, unknown> } }) =>
  ((view.conversation?.docs["pi.inbox"] ?? { items: [] }) as { items: { mode: string }[] }).items;

describe("remote controller", () => {
  it("steers a busy conversation from another client; both see the queue and the steered turn", async () => {
    const host = await startFauxHost(defer, { answers: [LONG_ANSWER, "steered"], tokensPerSecond: 60 });
    const driver = await connectTo(defer, host);
    const steerer = await connectTo(defer, host);

    const id = await startChat(driver, "investigate");
    await waitForView(steerer.view, (view) => view.organized.chats.some((node) => node.summary.id === id));
    await steerer.controller.switchConversation(id);
    await waitForView(steerer.view, (view) => isBusy(view.conversation!));
    await steerer.controller.submit("focus on the logs", "steer");
    await waitForView(driver.view, (view) => inboxOf(view).some((item) => item.mode === "steer"));

    await waitForView(driver.view, (view) => !isBusy(view.conversation!) && transcript(view.conversation!).at(-1)?.text === "steered");
    expect(transcript(driver.view.current().conversation!).map((line) => line.text)).toEqual([
      "investigate",
      LONG_ANSWER,
      "focus on the logs",
      "steered",
    ]);
  });

  it("aborts a streaming answer; the partial stays as an aborted entry", async () => {
    const host = await startFauxHost(defer, { tokensPerSecond: 40 });
    const client = await connectTo(defer, host);

    await startChat(client, "investigate");
    await waitForView(client.view, (view) => (streamingText(view.conversation!)?.length ?? 0) > 10);
    await client.controller.abort();
    await waitForView(client.view, (view) => !isBusy(view.conversation!));

    const [user, answer, ...rest] = transcript(client.view.current().conversation!);
    expect(user).toEqual({ role: "user", text: "investigate" });
    expect(answer).toMatchObject({ role: "assistant", stopReason: "aborted" });
    expect(rest).toEqual([]);
  });

  it("switches to another conversation and talks to it; the other client stays put", async () => {
    const host = await startFauxHost(defer, { answers: ["from the first conversation", "from the other conversation"] });
    const switcher = await connectTo(defer, host);
    const bystander = await connectTo(defer, host);
    const firstId = await startChat(switcher, "first");
    await bystander.controller.switchConversation(firstId);
    // An ownerless conversation outside the index is still addressable by stream.
    const { model } = (await host.harness.snapshot(AgentDoc, firstId, BACKGROUND_CONTEXT))!;
    const other = await host.harness.createConversation(
      { ownership: { kind: "ownerless" }, agent: { model: model! } },
      BACKGROUND_CONTEXT,
    );

    await switcher.controller.switchConversation(other.id);
    expect(switcher.view.current().conversation!.conversation.id).toBe(other.id);

    await switcher.controller.submit("hello other", "followUp");
    await waitForView(switcher.view, (view) => transcript(view.conversation!).at(-1)?.text === "from the other conversation");
    expect(bystander.view.current().conversation!.conversation.id).toBe(firstId);
    expect(transcript(bystander.view.current().conversation!).at(-1)?.text).toBe("from the first conversation");
  });

  it("reports a switch to an unknown conversation and keeps the current one", async () => {
    const host = await startFauxHost(defer);
    const client = await connectTo(defer, host);
    const shownId = await startChat(client, "hello");

    await client.controller.switchConversation(999 as ConversationId);

    expect(client.view.current().conversation!.conversation.id).toBe(shownId);
    expect(client.view.current().notices.at(-1)).toMatchObject({ level: "error", message: expect.stringMatching(/999/) });
  });

  it("notices when a command needs a conversation and none is shown", async () => {
    const host = await startFauxHost(defer);
    const client = await connectTo(defer, host);
    expect(client.view.current().conversation).toBeUndefined();

    await client.controller.submit("hello", "followUp");
    await waitForView(client.view, (view) => view.notices.some((notice) => notice.message === "No conversation selected"));
  });
});
