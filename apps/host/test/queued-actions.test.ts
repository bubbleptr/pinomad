import { once } from "node:events";
import { WebSocket } from "ws";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AgentDoc, type ConversationId, type InboxState, type SubmissionId } from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vitest";
import type { CallMethod, CallMethods, ServerFrame } from "@pinomad/protocol/frames.ts";
import { isBusy, streamingText, transcript } from "@pinomad/protocol/transcript.ts";
import type { DurableView } from "@pinomad/protocol/view.ts";
import { question } from "../src/extensions/question.ts";
import type { OpenedHost } from "../src/host.ts";
import { connectTo, startChat, startFauxHost, useCleanups, waitForView } from "./support.ts";

const defer = useCleanups();
const context = BACKGROUND_CONTEXT;
let nextCall = 1;
let nextRequest = 1;

type ResultFrame = Extract<ServerFrame, { type: "result" }>;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

/** A faux step that holds the run at the model request until the gate opens. */
function gatedTool(gate: Promise<void>, command = "true"): FauxResponseStep {
  return async () => {
    await gate;
    return fauxAssistantMessage(fauxToolCall("bash", { command }), { stopReason: "toolUse" });
  };
}

/** A raw client that can observe call results, which controller methods deliberately hide. */
async function socketTo(host: OpenedHost): Promise<{ socket: WebSocket; frames: ServerFrame[] }> {
  const socket = new WebSocket(`${host.url}?token=${encodeURIComponent(host.token)}`);
  defer(() => socket.terminate());
  const frames: ServerFrame[] = [];
  socket.on("message", (data) => frames.push(JSON.parse(String(data)) as ServerFrame));
  await once(socket, "open");
  return { socket, frames };
}

function call<M extends CallMethod>(
  client: { socket: WebSocket; frames: ServerFrame[] },
  method: M,
  args: CallMethods[M]["args"],
): Promise<ResultFrame> {
  const id = nextCall++;
  client.socket.send(JSON.stringify({ type: "call", id, method, args }));
  return (async () => {
    for (;;) {
      const found = client.frames.find((frame): frame is ResultFrame => frame.type === "result" && frame.id === id);
      if (found !== undefined) return found;
      await once(client.socket, "message");
    }
  })();
}

async function submit(
  client: { socket: WebSocket; frames: ServerFrame[] },
  conversationId: ConversationId,
  text: string,
): Promise<number> {
  const result = await call(client, "submit", {
    conversationId,
    text,
    whenBusy: "followUp",
    requestId: `queued-actions:${nextRequest++}`,
  });
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) throw new Error(result.error);
  return (result.value as { submissionId: number }).submissionId;
}

const inboxOf = (view: DurableView): InboxState["items"] =>
  ((view.conversation?.docs["pi.inbox"] ?? { items: [] }) as InboxState).items;

const pendingQuestions = (view: DurableView) => {
  const doc = view.docs.find((candidate) => candidate.presentation === "pinomad.question");
  const value = doc?.value as { requests?: { resolution?: unknown }[] } | null | undefined;
  return value?.requests?.filter((request) => request.resolution === undefined) ?? [];
};

async function recordOf(host: OpenedHost, id: number) {
  const submission = await host.harness.submission(id as SubmissionId, context);
  return submission?.status(context);
}

async function placedSubmissionId(host: OpenedHost, conversationId: ConversationId): Promise<number> {
  const inspection = await host.harness.inspect(context);
  const found = inspection.submissions.find(
    (submission) => submission.conversationId === conversationId && submission.status === "placed",
  );
  expect(found).toBeDefined();
  return found!.id as unknown as number;
}

describe("queued input calls", () => {
  it("withdraws a queued input, loses it from the inbox, and stays withdrawn on a repeat", async () => {
    const gate = deferred();
    defer(gate.resolve);
    const host = await startFauxHost(defer, { answers: [gatedTool(gate.promise), "done"] });
    const client = await connectTo(defer, host);
    const conversationId = await startChat(client, "investigate");
    await waitForView(client.view, (view) => isBusy(view.conversation!));
    const raw = await socketTo(host);

    const queued = await submit(raw, conversationId, "take it back");
    await waitForView(client.view, (view) => inboxOf(view).some((item) => item.id === queued));

    expect(await call(raw, "withdrawQueued", { conversationId, submissionId: queued })).toMatchObject({
      ok: true,
      value: { outcome: "withdrawn" },
    });
    await waitForView(client.view, (view) => !inboxOf(view).some((item) => item.id === queued));
    expect(await call(raw, "withdrawQueued", { conversationId, submissionId: queued })).toMatchObject({
      ok: true,
      value: { outcome: "withdrawn" },
    });

    const record = await recordOf(host, queued);
    expect(record).toMatchObject({ status: "unanswered", reason: "aborted" });
    expect(record?.entry).toBeUndefined();

    gate.resolve();
    await waitForView(client.view, (view) => !isBusy(view.conversation!));
  });

  it("reports sent for an input the boundary already placed", async () => {
    const gate = deferred();
    defer(gate.resolve);
    const host = await startFauxHost(defer, { answers: [gatedTool(gate.promise), "done"] });
    const client = await connectTo(defer, host);
    const conversationId = await startChat(client, "investigate");
    await waitForView(client.view, (view) => isBusy(view.conversation!));
    const raw = await socketTo(host);
    const placed = await placedSubmissionId(host, conversationId);

    expect(await call(raw, "withdrawQueued", { conversationId, submissionId: placed })).toMatchObject({
      ok: true,
      value: { outcome: "sent" },
    });
    expect(await recordOf(host, placed)).toMatchObject({ status: "placed" });

    gate.resolve();
    await waitForView(client.view, (view) => !isBusy(view.conversation!));
  });

  it("reports sent, not withdrawn, when a placed input is aborted after it reached the transcript", async () => {
    // A streaming answer leaves the run mid-flight; aborting it settles the
    // placed input unanswered/aborted but keeps its entry.
    const host = await startFauxHost(defer, { tokensPerSecond: 40 });
    const client = await connectTo(defer, host);
    const conversationId = await startChat(client, "investigate");
    await waitForView(client.view, (view) => (streamingText(view.conversation!)?.length ?? 0) > 10);
    const placed = await placedSubmissionId(host, conversationId);

    await client.controller.abort();
    await waitForView(client.view, (view) => !isBusy(view.conversation!));
    const aborted = await recordOf(host, placed);
    expect(aborted).toMatchObject({ status: "unanswered", reason: "aborted" });
    expect(aborted?.entry).toBeDefined();

    const raw = await socketTo(host);
    expect(await call(raw, "withdrawQueued", { conversationId, submissionId: placed })).toMatchObject({
      ok: true,
      value: { outcome: "sent" },
    });
  });

  it("refuses writes, unknown ids, and another conversation's id", async () => {
    const gate = deferred();
    defer(gate.resolve);
    const host = await startFauxHost(defer, { answers: [gatedTool(gate.promise), "done"] });
    const client = await connectTo(defer, host);
    const conversationId = await startChat(client, "investigate");
    await waitForView(client.view, (view) => isBusy(view.conversation!));
    const raw = await socketTo(host);

    const queued = await submit(raw, conversationId, "queued");
    const conversation = await host.harness.conversation(conversationId, context);
    const write = await conversation!.submit(
      {
        type: "write",
        entry: {
          kind: "pinomad.note",
          data: { note: "x" },
          model: [{ role: "user", content: "note", timestamp: Date.now() }],
        },
      },
      context,
    );
    await waitForView(client.view, (view) => inboxOf(view).some((item) => item.id === (write.id as unknown as number)));

    const agent = await host.harness.snapshot(AgentDoc, conversationId, context);
    const other = await host.harness.createConversation(
      { ownership: { kind: "ownerless" }, agent: { model: agent!.model! } },
      context,
    );

    expect(await call(raw, "withdrawQueued", { conversationId, submissionId: write.id as unknown as number })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/write/i),
    });
    expect(await call(raw, "steerQueued", { conversationId, submissionId: write.id as unknown as number })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/write/i),
    });
    expect(await call(raw, "withdrawQueued", { conversationId, submissionId: 999_999 })).toMatchObject({
      ok: false,
      error: expect.stringContaining("999999"),
    });
    expect(await call(raw, "steerQueued", { conversationId, submissionId: 999_999 })).toMatchObject({
      ok: false,
      error: expect.stringContaining("999999"),
    });
    for (const method of ["withdrawQueued", "steerQueued"] as const) {
      expect(await call(raw, method, { conversationId: other.id, submissionId: queued })).toMatchObject({
        ok: false,
        error: expect.stringMatching(/another conversation/i),
      });
    }

    gate.resolve();
    await waitForView(client.view, (view) => !isBusy(view.conversation!));
  });

  it("promotes a queued follow-up to steer and places it at the next postTools boundary", async () => {
    const gate = deferred();
    defer(gate.resolve);
    const host = await startFauxHost(defer, { answers: [gatedTool(gate.promise), "after the steer"] });
    const client = await connectTo(defer, host);
    const conversationId = await startChat(client, "investigate");
    await waitForView(client.view, (view) => isBusy(view.conversation!));
    const raw = await socketTo(host);

    const queued = await submit(raw, conversationId, "promote me");
    await waitForView(client.view, (view) => inboxOf(view).some((item) => item.id === queued && item.mode === "followUp"));
    expect(await call(raw, "steerQueued", { conversationId, submissionId: queued })).toMatchObject({
      ok: true,
      value: { outcome: "steered" },
    });
    await waitForView(client.view, (view) => inboxOf(view).some((item) => item.id === queued && item.mode === "steer"));

    gate.resolve();
    await waitForView(
      client.view,
      (view) => !isBusy(view.conversation!) && transcript(view.conversation!).at(-1)?.text === "after the steer",
    );
    expect(transcript(client.view.current().conversation!).filter((line) => line.role === "user").map((line) => line.text)).toEqual([
      "investigate",
      "promote me",
    ]);
    expect(inboxOf(client.view.current())).toEqual([]);
    expect(await recordOf(host, queued)).toMatchObject({ status: "done" });
  });

  it("reports sent, unavailable and failures without closing a pending question; steered closes it", async () => {
    const host = await startFauxHost(defer, {
      extensions: [question],
      answers: [
        fauxAssistantMessage(
          fauxToolCall("ask_user_question", {
            questions: [{ header: "Deploy", question: "Deploy now?", options: [{ label: "Yes" }, { label: "No" }] }],
          }),
          { stopReason: "toolUse" },
        ),
        "got your message",
      ],
    });
    const client = await connectTo(defer, host);
    const conversationId = await startChat(client, "ask me");
    await waitForView(client.view, (view) => pendingQuestions(view).length === 1);
    const placed = await placedSubmissionId(host, conversationId);
    const raw = await socketTo(host);
    // Host-side reads: a non-dismissing call must leave the committed doc
    // untouched, whatever the watch stream's delivery timing is.
    const questionDoc = question.docs![0]!.token;
    const pendingInHost = async (): Promise<number> => {
      const value = (await host.harness.snapshot(questionDoc, conversationId, context)) as
        | { requests: { resolution?: unknown }[] }
        | undefined;
      return value?.requests.filter((request) => request.resolution === undefined).length ?? 0;
    };
    // Queue through the harness: the gateway's submit dismisses a pending
    // question on its own (ADR-0011 §4), which is not what this tests.
    const conversation = await host.harness.conversation(conversationId, context);
    const first = await conversation!.submit(
      { type: "input", content: "first queued", whenBusy: "followUp" },
      context,
    );
    const second = await conversation!.submit(
      { type: "input", content: "second queued", whenBusy: "followUp" },
      context,
    );
    const firstId = first.id as unknown as number;
    const secondId = second.id as unknown as number;
    await waitForView(client.view, (view) => inboxOf(view).some((item) => item.id === secondId));

    expect(await call(raw, "steerQueued", { conversationId, submissionId: placed })).toMatchObject({
      ok: true,
      value: { outcome: "sent" },
    });
    expect(await pendingInHost()).toBe(1);

    expect(await call(raw, "withdrawQueued", { conversationId, submissionId: firstId })).toMatchObject({
      ok: true,
      value: { outcome: "withdrawn" },
    });
    expect(await call(raw, "steerQueued", { conversationId, submissionId: firstId })).toMatchObject({
      ok: true,
      value: { outcome: "unavailable" },
    });
    expect(await pendingInHost()).toBe(1);

    expect(await call(raw, "steerQueued", { conversationId, submissionId: 999_999 })).toMatchObject({ ok: false });
    expect(await pendingInHost()).toBe(1);

    expect(await call(raw, "steerQueued", { conversationId, submissionId: secondId })).toMatchObject({
      ok: true,
      value: { outcome: "steered" },
    });
    await waitForView(
      client.view,
      (view) =>
        pendingQuestions(view).length === 0
        && !isBusy(view.conversation!)
        && transcript(view.conversation!).at(-1)?.text === "got your message",
    );
    const resolved = (await host.harness.snapshot(questionDoc, conversationId, context)) as {
      requests: { resolution?: { outcome: string } }[];
    };
    expect(resolved.requests[0]!.resolution).toMatchObject({ outcome: "dismissed" });
  });

  it("does not fail when a steer races the parent task's cancellation of an owned conversation", async () => {
    const ask = (question: string, header: string) =>
      fauxAssistantMessage(
        fauxToolCall("ask_user_question", {
          questions: [{ header, question, options: [{ label: "Yes" }, { label: "No" }] }],
        }),
        { stopReason: "toolUse" },
      );
    const host = await startFauxHost(defer, {
      extensions: [question],
      answers: [ask("Deploy now?", "Deploy"), ask("Ship now?", "Ship")],
    });
    const client = await connectTo(defer, host);
    const mainId = await startChat(client, "parent");
    await waitForView(client.view, (view) => pendingQuestions(view).length === 1);

    const generation = (await host.harness.inspect(context)).tasks.find(
      (task) => task.record.conversationId === mainId && task.record.kind === "pi.generation",
    );
    expect(generation).toBeDefined();
    const agent = await host.harness.snapshot(AgentDoc, mainId, context);
    const owned = await host.harness.createConversation(
      { ownership: { kind: "task", taskId: generation!.record.id }, agent: { model: agent!.model! } },
      context,
    );
    const ownedConversation = await host.harness.conversation(owned.id, context);
    await ownedConversation!.submit({ type: "input", content: "owned first", whenBusy: "followUp" }, context);
    const queued = await ownedConversation!.submit(
      { type: "input", content: "steer me", whenBusy: "followUp" },
      context,
    );
    const raw = await socketTo(host);

    // Both commits land in some order; neither may throw, and a steered
    // promotion is withdrawn by the cascade just like a queued one.
    const [steer, abort] = await Promise.all([
      call(raw, "steerQueued", { conversationId: owned.id, submissionId: queued.id as unknown as number }),
      host.harness.abortTask(generation!.record.id, context),
    ]);
    expect(abort).toBe("marked");
    expect(steer).toMatchObject({ ok: true });
    if (!steer.ok) throw new Error(steer.error);
    expect(["steered", "unavailable"]).toContain((steer.value as { outcome: string }).outcome);

    await host.harness.waitForIdle(context);
    await ownedConversation!.waitForIdle(context);
    const settled = await (await host.harness.submission(queued.id, context))!.wait(context);
    expect(settled).toMatchObject({ status: "unanswered", reason: "aborted" });
  });
});
