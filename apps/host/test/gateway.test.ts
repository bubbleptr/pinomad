import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import { streamingText, transcript } from "@pinomad/protocol/transcript.ts";
import { question } from "../src/extensions/question.ts";
import { connectTo, LONG_ANSWER, startChat, startFauxHost, tempDir, useCleanups, waitForView } from "./support.ts";

const defer = useCleanups();

describe("gateway", () => {
  it("shows one streamed answer to two clients, driven by either", async () => {
    const host = await startFauxHost(defer);
    const a = await connectTo(defer, host);
    const b = await connectTo(defer, host);
    const id = await startChat(a, "investigate");
    await b.controller.switchConversation(id);
    expect(b.view.current().conversation!.conversation.id).toBe(id);

    const partialsSeenByB: string[] = [];
    b.view.subscribe(() => {
      const text = streamingText(b.view.current().conversation!);
      if (text !== undefined && text !== "") partialsSeenByB.push(text);
    });

    const answered = (client: RemoteDurable) =>
      waitForView(client.view, (view) => transcript(view.conversation!).at(-1)?.text === LONG_ANSWER);
    await Promise.all([answered(a), answered(b)]);

    expect(transcript(b.view.current().conversation!)).toEqual([
      { role: "user", text: "investigate" },
      { role: "assistant", text: LONG_ANSWER, stopReason: "stop" },
    ]);
    expect(b.view.current().conversation).toEqual(a.view.current().conversation);
    expect(partialsSeenByB.length).toBeGreaterThan(0);
    for (const partial of partialsSeenByB) expect(LONG_ANSWER.startsWith(partial)).toBe(true);
    expect(partialsSeenByB.some((partial) => partial.length < LONG_ANSWER.length)).toBe(true);
  });

  it("rejects a client with the wrong token", async () => {
    const host = await startFauxHost(defer);
    await expect(connectTo(defer, host, "not-the-token")).rejects.toThrow(/unauthorized/i);
  });

  it("lists the same conversation titles before and after the host restarts", async () => {
    const first = await startFauxHost(defer, { answers: ["done"] });
    const before = await connectTo(defer, first);
    await startChat(before, "what broke v2.3?");
    // Settle fully before snapshotting: the answer's text streams in through the
    // live partial before the entry commits and `run` clears.
    await waitForView(
      before.view,
      (view) =>
        view.organized.chats[0]?.summary.status === undefined && transcript(view.conversation!).at(-1)?.text === "done",
    );
    const dataDir = before.view.current().session.directory;
    before.close();
    await first.close();

    const second = await startFauxHost(defer, { dataDir });
    const after = await connectTo(defer, second);
    expect(after.view.current().organized.chats.map((node) => node.summary)).toEqual(
      before.view.current().organized.chats.map((node) => node.summary),
    );
    expect(after.view.current().organized.chats[0]?.summary).toMatchObject({
      kind: "conversation",
      title: "what broke v2.3?",
      updatedAt: expect.any(Number),
    });
    expect(after.view.current().organized.chats[0]?.summary.status).toBeUndefined();
  });

  it("lists the conversations and opens the task graph on request", async () => {
    const host = await startFauxHost(defer);
    const client = await connectTo(defer, host);
    const id = await startChat(client, "hello");
    await waitForView(client.view, (view) => view.organized.chats.some((node) => node.summary.id === id));

    expect(client.view.current().tasks).toBeUndefined();
    await client.controller.toggleTasks();
    await waitForView(client.view, (view) => view.tasks !== undefined);
    await client.controller.toggleTasks();
    expect(client.view.current().tasks).toBeUndefined();
  });

  it("marks a conversation needs-answer while a question is pending, surviving restart", async () => {
    const dir = await tempDir();
    defer(dir.remove);
    const first = await startFauxHost(defer, {
      dataDir: dir.path,
      extensions: [question],
      answers: [
        fauxAssistantMessage(
          fauxToolCall("ask_user_question", {
            questions: [{ header: "Deploy", question: "Deploy now?", options: [{ label: "Yes" }, { label: "No" }] }],
          }),
          { stopReason: "toolUse" },
        ),
      ],
    });
    const client = await connectTo(defer, first);
    const id = await startChat(client, "deploy?");
    await waitForView(client.view, (view) => view.organized.chats[0]?.summary.status === "needs-answer");
    // The request id rides on the shown conversation's doc stream.
    await waitForView(
      client.view,
      (view) =>
        (view.docs.find((doc) => doc.presentation === "pinomad.question")?.value as
          | { requests: { id: string }[] }
          | null
          | undefined)?.requests[0]?.id !== undefined,
    );
    const requestId = (
      client.view.current().docs.find((doc) => doc.presentation === "pinomad.question")!.value as {
        requests: { id: string }[];
      }
    ).requests[0]!.id;
    client.close();
    await first.close();

    // The pending request is persisted, so a restarted host derives it at open.
    const second = await startFauxHost(defer, { dataDir: dir.path, extensions: [question], answers: ["all answered"] });
    const after = await connectTo(defer, second);
    await waitForView(after.view, (view) => view.organized.chats[0]?.summary.status === "needs-answer");

    await after.controller.switchConversation(id);
    await after.controller.answer("question.requests", requestId, [{ selected: ["Yes"] }]);
    // Once answered the run resumes and finishes — no status remains.
    await waitForView(
      after.view,
      (view) => view.organized.chats[0]?.summary.status === undefined && transcript(view.conversation!).at(-1)?.text === "all answered",
    );
  });

  it("marks a conversation running while its run is in flight, then clears", async () => {
    let finish!: (message: ReturnType<typeof fauxAssistantMessage>) => void;
    const gate = new Promise<ReturnType<typeof fauxAssistantMessage>>((resolve) => (finish = resolve));
    const blocked: FauxResponseFactory = () => gate;
    const host = await startFauxHost(defer, { answers: [blocked] });
    const client = await connectTo(defer, host);

    await startChat(client, "wait");
    await waitForView(client.view, (view) => view.organized.chats[0]?.summary.status === "running");
    finish(fauxAssistantMessage("done"));
    await waitForView(
      client.view,
      (view) => view.organized.chats[0]?.summary.status === undefined && transcript(view.conversation!).at(-1)?.text === "done",
    );
  });

  it("marks a conversation failed after a run error, surviving restart, until the next message", async () => {
    const dir = await tempDir();
    defer(dir.remove);
    const first = await startFauxHost(defer, {
      dataDir: dir.path,
      answers: [fauxAssistantMessage("boom", { errorMessage: "provider blew up", stopReason: "error" })],
    });
    const client = await connectTo(defer, first);
    const id = await startChat(client, "try it");
    await waitForView(client.view, (view) => view.organized.chats[0]?.summary.status === "failed");
    client.close();
    await first.close();

    const second = await startFauxHost(defer, { dataDir: dir.path, answers: ["recovered"] });
    const after = await connectTo(defer, second);
    await waitForView(after.view, (view) => view.organized.chats[0]?.summary.status === "failed");

    // A later user message clears the failure for the next run.
    await after.controller.switchConversation(id);
    await after.controller.submit("again", "followUp");
    await waitForView(
      after.view,
      (view) => view.organized.chats[0]?.summary.status === undefined && transcript(view.conversation!).at(-1)?.text === "recovered",
    );
  });

  it("runs a side conversation beside the main one", async () => {
    const host = await startFauxHost(defer, { answers: ["parent answer", "side answer"] });
    const client = await connectTo(defer, host);
    const parentId = await startChat(client, "parent");
    await waitForView(client.view, (view) => transcript(view.conversation!).at(-1)?.text === "parent answer");

    // Fork the parent's answer so the side slot shows a different conversation.
    const at = client.view.current().conversation!.entries.at(-1)!.id;
    const forkId = await host.harness.commit(
      async (tx) => (await tx.forkConversation(parentId, at, { ownership: { kind: "ownerless" } })).id,
      BACKGROUND_CONTEXT,
    );

    await client.controller.showSide(forkId);
    await waitForView(client.view, (view) => view.side?.id === forkId && view.side.conversation !== undefined);

    // A targeted submit talks to the side; the main transcript is untouched.
    await client.controller.submit("side question", "followUp", forkId);
    await waitForView(client.view, (view) => transcript(view.side!.conversation!).at(-1)?.text === "side answer");
    expect(transcript(client.view.current().conversation!).at(-1)?.text).toBe("parent answer");
  });

  it("reports no updatedAt on a fork that has no own messages yet", async () => {
    const host = await startFauxHost(defer, { answers: ["parent done"] });
    const client = await connectTo(defer, host);
    const parentId = await startChat(client, "parent");
    await waitForView(client.view, (view) => transcript(view.conversation!).at(-1)?.text === "parent done");
    const at = client.view.current().conversation!.entries.at(-1)!.id;

    // A fork record with no submitted message: every entry it shows is inherited.
    const forkId = await host.harness.commit(
      async (tx) => (await tx.forkConversation(parentId, at, { ownership: { kind: "ownerless" } })).id,
      BACKGROUND_CONTEXT,
    );
    await waitForView(client.view, (view) =>
      view.organized.chats.some((node) => node.children.some((child) => child.summary.id === forkId)),
    );
    const fork = client
      .view.current()
      .organized.chats.flatMap((node) => node.children)
      .find((node) => node.summary.id === forkId)!.summary;
    expect(fork.kind).toBe("fork");
    expect(fork.updatedAt).toBeUndefined();
  });
});
