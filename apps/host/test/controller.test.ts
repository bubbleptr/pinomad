import { once } from "node:events";
import { WebSocket } from "ws";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AgentDoc, type ConversationId } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import type { CallMethods, ServerFrame } from "@pinomad/protocol/frames.ts";
import type { OpenedHost } from "../src/host.ts";
import { isBusy, streamingText, transcript } from "@pinomad/protocol/transcript.ts";
import { connectTo, LONG_ANSWER, startChat, startFauxHost, useCleanups, waitForView } from "./support.ts";

const defer = useCleanups();
let nextCall = 1;

/** A raw client that can observe call results, which controller methods deliberately hide. */
async function socketTo(host: OpenedHost) {
  const socket = new WebSocket(`${host.url}?token=${encodeURIComponent(host.token)}`);
  defer(() => socket.terminate());
  const frames: ServerFrame[] = [];
  socket.on("message", (data) => frames.push(JSON.parse(String(data)) as ServerFrame));
  await once(socket, "open");
  return { socket, frames };
}

function call<M extends keyof CallMethods>(
  client: { socket: WebSocket; frames: ServerFrame[] },
  method: M,
  args: CallMethods[M]["args"],
): Promise<Extract<ServerFrame, { type: "result" }>> {
  const id = nextCall++;
  client.socket.send(JSON.stringify({ type: "call", id, method, args }));
  return (async () => {
    for (;;) {
      const found = client.frames.find(
        (frame): frame is Extract<ServerFrame, { type: "result" }> => frame.type === "result" && frame.id === id,
      );
      if (found !== undefined) return found;
      await once(client.socket, "message");
    }
  })();
}

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

  it("carries the host's defaults on hello and the models' thinking levels", async () => {
    const host = await startFauxHost(defer, {
      fauxModels: [
        { id: "faux-1", name: "Faux Model" },
        { id: "faux-thinker", name: "Faux Thinker", reasoning: true },
      ],
    });
    const client = await connectTo(defer, host);

    expect(client.view.current().defaults.model).toEqual({ provider: "faux", modelId: "faux-1" });
    const summaries = client.view.current().models;
    expect(summaries.find((each) => each.modelId === "faux-1")?.thinkingLevels).toEqual(["off"]);
    const thinkerLevels = summaries.find((each) => each.modelId === "faux-thinker")?.thinkingLevels;
    expect(thinkerLevels?.[0]).toBe("off");
    expect(thinkerLevels).toContain("high");
  });

  it("creates a conversation with an explicit model and a clamped thinking level", async () => {
    const host = await startFauxHost(defer, {
      fauxModels: [
        { id: "faux-1", name: "Faux Model" },
        { id: "faux-thinker", name: "Faux Thinker", reasoning: true },
      ],
      answers: ["done"],
    });
    const client = await connectTo(defer, host);

    // faux-thinker has no xhigh/max mapping; xhigh clamps down to high.
    await client.controller.createConversation(
      { kind: "chat" },
      "hello",
      { model: { provider: "faux", modelId: "faux-thinker" }, thinkingLevel: "xhigh" },
    );
    const id = client.view.current().conversation!.conversation.id;
    const state = await host.harness.snapshot(AgentDoc, id, BACKGROUND_CONTEXT);
    expect(state?.model).toEqual({ provider: "faux", modelId: "faux-thinker" });
    expect(state?.thinkingLevel).toBe("high");
  });

  it("notices instead of creating when the requested model is unknown", async () => {
    const host = await startFauxHost(defer);
    const client = await connectTo(defer, host);

    await client.controller.createConversation(
      { kind: "chat" },
      "hello",
      { model: { provider: "faux", modelId: "nope" } },
    );
    await waitForView(client.view, (view) =>
      view.notices.some((notice) => notice.level === "error" && notice.message === "Unknown model: faux/nope"),
    );
    expect(client.view.current().conversation).toBeUndefined();
  });

  it("sets a supported thinking level and notices an unsupported one", async () => {
    const host = await startFauxHost(defer, {
      fauxModels: [{ id: "faux-thinker", name: "Faux Thinker", reasoning: true }],
      answers: ["done"],
    });
    const client = await connectTo(defer, host);

    const id = await startChat(client, "hello");
    await client.controller.setThinkingLevel("medium");
    await expect
      .poll(async () => (await host.harness.snapshot(AgentDoc, id, BACKGROUND_CONTEXT))?.thinkingLevel)
      .toBe("medium");

    await client.controller.setThinkingLevel("xhigh");
    await waitForView(client.view, (view) =>
      view.notices.some(
        (notice) =>
          notice.level === "error" && notice.message === "Thinking level xhigh is not supported by faux/faux-thinker",
      ),
    );
  });

  it("returns the existing conversation for a repeated create requestId with a now-unknown model", async () => {
    const host = await startFauxHost(defer, { answers: ["first"] });
    const client = await socketTo(host);

    const first = await call(client, "createConversation", {
      home: { kind: "chat" },
      text: "hi",
      requestId: "dup-1",
      model: { provider: "faux", modelId: "faux-1" },
    });
    expect(first).toMatchObject({ ok: true });
    const firstId = (first as { value?: { conversationId: string } }).value?.conversationId;
    expect(firstId).toBeDefined();

    // A retry of the same request resolves to the existing conversation even
    // though its model is no longer known.
    const second = await call(client, "createConversation", {
      home: { kind: "chat" },
      text: "hi",
      requestId: "dup-1",
      model: { provider: "faux", modelId: "removed" },
    });
    expect(second).toMatchObject({ ok: true, value: { conversationId: firstId } });
  });
});
