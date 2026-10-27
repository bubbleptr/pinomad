// Submission receipts (issue #402, PR 1): the read-only `submission` query,
// early request-id dedupe in `submit`, and `entry` on the submit result.
import { once } from "node:events";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseStep,
} from "@earendil-works/pi-ai/providers/faux";
import { WebSocket } from "ws";
import { describe, expect, it, vi } from "vitest";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { CallMethod, CallMethods, ServerFrame } from "@pinomad/protocol/frames.ts";
import { isBusy, transcript } from "@pinomad/protocol/transcript.ts";
import { AttachmentStore } from "../src/attachments.ts";
import { question } from "../src/extensions/question.ts";
import { connectTo, startChat, startFauxHost, useCleanups, waitForView } from "./support.ts";

const defer = useCleanups();
const context = BACKGROUND_CONTEXT;

type ResultFrame = Extract<ServerFrame, { type: "result" }>;
type SubmissionReply = { submissionId: number; status: "queued" | "placed" | "done" | "unanswered"; entry?: number };

const valueOf = <T>(frame: ResultFrame): T => {
  if (!frame.ok) throw new Error(frame.error);
  return frame.value as T;
};

interface Raw {
  readonly frames: ServerFrame[];
  call<M extends CallMethod>(method: M, args: CallMethods[M]["args"]): Promise<ResultFrame>;
  close(): void;
}

/** A raw socket, so tests can observe the exact result frames a controller hides. */
async function rawClient(host: { url: string; token: string }): Promise<Raw> {
  const socket = new WebSocket(`${host.url}?token=${encodeURIComponent(host.token)}`);
  defer(() => socket.terminate());
  const frames: ServerFrame[] = [];
  const pending = new Map<number, (frame: ResultFrame) => void>();
  let next = 1;
  socket.on("message", (data) => {
    const frame = JSON.parse(String(data)) as ServerFrame;
    frames.push(frame);
    if (frame.type !== "result") return;
    pending.get(frame.id)?.(frame);
    pending.delete(frame.id);
  });
  await once(socket, "open");
  return {
    frames,
    call: (method, args) =>
      new Promise((resolve) => {
        const id = next++;
        pending.set(id, resolve);
        socket.send(JSON.stringify({ type: "call", id, method, args }));
      }),
    close: () => socket.terminate(),
  };
}

/** Wait until the shown conversation is idle and its last transcript line has `text`. */
function settled(client: Awaited<ReturnType<typeof connectTo>>, text: string): Promise<void> {
  return waitForView(
    client.view,
    (view) => !isBusy(view.conversation!) && transcript(view.conversation!).at(-1)?.text === text,
  );
}

/** The stored question requests, read on the host line so no view frame can race the assertion. */
async function storedQuestions(host: Awaited<ReturnType<typeof startFauxHost>>, conversationId: ConversationId) {
  const token = question.docs![0]!.token;
  const doc = (await host.harness.snapshot(token, conversationId, context)) as
    | { requests?: { resolution?: unknown }[] }
    | undefined;
  return doc?.requests ?? [];
}

/** A faux step that holds its run until the gate opens. */
function gatedAnswer(gate: Promise<void>, text: string): FauxResponseStep {
  return async () => {
    await gate;
    return fauxAssistantMessage(text);
  };
}

/** The request the question tool call creates, shaped like the gateway test's. */
const QUESTION_CALL = fauxAssistantMessage(
  fauxToolCall("ask_user_question", {
    questions: [{ header: "Deploy", question: "Deploy now?", options: [{ label: "Yes" }, { label: "No" }] }],
  }),
  { stopReason: "toolUse" },
);

const userTexts = (client: Awaited<ReturnType<typeof connectTo>>): string[] =>
  transcript(client.view.current().conversation!).flatMap((line) => (line.role === "user" ? [line.text] : []));

async function upload(client: Awaited<ReturnType<typeof connectTo>>, name: string, text: string): Promise<string> {
  const bytes = Buffer.from(text);
  const id = await client.controller.beginAttachment(name, bytes.length);
  await client.controller.appendAttachment(id, 0, bytes.toString("base64"));
  return id;
}

describe("submission receipts", () => {
  it("returns the original record without rerunning submit preprocessing", async () => {
    const host = await startFauxHost(defer, {
      extensions: [question],
      answers: ["started", "first", QUESTION_CALL, "never answered"],
    });
    const client = await connectTo(defer, host);
    const conversationId = await startChat(client, "start");
    await settled(client, "started");
    const raw = await rawClient(host);

    const first = await raw.call("submit", {
      conversationId,
      text: "first",
      whenBusy: "followUp",
      requestId: "duplicate",
    });
    expect(first.ok).toBe(true);
    const firstReply = valueOf<SubmissionReply>(first);
    expect(firstReply).toMatchObject({ submissionId: expect.any(Number), entry: expect.any(Number) });
    await settled(client, "first");

    const asked = await raw.call("submit", {
      conversationId,
      text: "ask",
      whenBusy: "followUp",
      requestId: "question",
    });
    expect(asked.ok).toBe(true);
    await waitForView(
      client.view,
      (view) => (view.docs.find((doc) => doc.presentation === "pinomad.question")?.value as
        | { requests: { resolution?: unknown }[] }
        | null
        | undefined)?.requests?.some((request) => request.resolution === undefined) === true,
    );
    expect((await storedQuestions(host, conversationId))[0]?.resolution).toBeUndefined();

    // Read-only: the query must not dismiss the pending question either.
    expect(await raw.call("submission", { conversationId, requestId: "duplicate" })).toMatchObject({
      ok: true,
      value: { submissionId: firstReply.submissionId, status: "done", entry: firstReply.entry },
    });
    expect((await storedQuestions(host, conversationId))[0]?.resolution).toBeUndefined();

    // An unavailable image ref would fail a fresh submit; a duplicate skips it.
    const duplicateImage = await raw.call("submit", {
      conversationId,
      text: "again",
      whenBusy: "followUp",
      requestId: "duplicate",
      images: [{ ref: "missing-image-ref" }],
    });
    expect(valueOf<SubmissionReply>(duplicateImage)).toEqual(firstReply);
    expect((await storedQuestions(host, conversationId))[0]?.resolution).toBeUndefined();

    // A duplicate also skips skill expansion: no ghost notice, and the
    // question is still pending (dismiss would have resumed the run).
    const before = raw.frames.length;
    const duplicateSkill = await raw.call("submit", {
      conversationId,
      text: "$ghost again",
      whenBusy: "followUp",
      requestId: "duplicate",
      skills: ["ghost"],
    });
    expect(valueOf<SubmissionReply>(duplicateSkill)).toEqual(firstReply);
    expect((await storedQuestions(host, conversationId))[0]?.resolution).toBeUndefined();
    expect(
      raw.frames
        .slice(before)
        .filter(
          (frame) =>
            frame.type === "notice"
            && (frame.level === "warning" || frame.level === "error")
            && /skill/i.test(frame.message),
        ),
    ).toEqual([]);

    expect(userTexts(client)).toEqual(["start", "first", "ask"]);
    expect(await raw.call("submission", { conversationId, requestId: "duplicate" })).toMatchObject({
      ok: true,
      value: { submissionId: firstReply.submissionId, status: "done", entry: firstReply.entry },
    });
  });

  it("answers the submission query in every state, with no entry until the record has one", async () => {
    let finishPlaced!: () => void;
    let finishBusy!: () => void;
    const placedGate = new Promise<void>((resolve) => (finishPlaced = resolve));
    const busyGate = new Promise<void>((resolve) => (finishBusy = resolve));
    const host = await startFauxHost(defer, {
      answers: ["started", gatedAnswer(placedGate, "placed done"), gatedAnswer(busyGate, "busy done")],
    });
    const client = await connectTo(defer, host);
    const conversationId = await startChat(client, "start");
    await settled(client, "started");
    const raw = await rawClient(host);

    const missing = await raw.call("submission", { conversationId, requestId: "missing" });
    expect(missing).toMatchObject({ ok: true, value: null });

    const placed = await raw.call("submit", {
      conversationId,
      text: "placed",
      whenBusy: "followUp",
      requestId: "placed",
    });
    expect(placed.ok).toBe(true);
    const placedReply = valueOf<SubmissionReply>(placed);
    const placedId = placedReply.submissionId;
    const placedEntry = placedReply.entry;
    expect(placedEntry).toBeGreaterThan(0);
    expect(await raw.call("submission", { conversationId, requestId: "placed" })).toMatchObject({
      ok: true,
      value: { submissionId: placedId, status: "placed", entry: placedEntry },
    });

    finishPlaced();
    await settled(client, "placed done");
    expect(await raw.call("submission", { conversationId, requestId: "placed" })).toMatchObject({
      ok: true,
      value: { submissionId: placedId, status: "done", entry: placedEntry },
    });

    const busy = await raw.call("submit", {
      conversationId,
      text: "busy",
      whenBusy: "followUp",
      requestId: "busy",
    });
    expect(busy.ok).toBe(true);
    await waitForView(client.view, (view) => isBusy(view.conversation!));
    expect(await raw.call("submission", { conversationId, requestId: "busy" })).toMatchObject({
      ok: true,
      value: { status: "placed", entry: valueOf<SubmissionReply>(busy).entry },
    });

    const queued = await raw.call("submit", {
      conversationId,
      text: "queued",
      whenBusy: "followUp",
      requestId: "queued",
    });
    expect(queued.ok).toBe(true);
    const queuedReply = valueOf<SubmissionReply>(queued);
    expect(queuedReply).not.toHaveProperty("entry");
    expect(await raw.call("submission", { conversationId, requestId: "queued" })).toMatchObject({
      ok: true,
      value: { submissionId: queuedReply.submissionId, status: "queued" },
    });
    const queuedRecord = await raw.call("submission", { conversationId, requestId: "queued" });
    expect(valueOf<SubmissionReply>(queuedRecord).entry).toBeUndefined();

    await raw.call("withdrawQueued", {
      conversationId,
      submissionId: queuedReply.submissionId,
    });
    expect(await raw.call("submission", { conversationId, requestId: "queued" })).toMatchObject({
      ok: true,
      value: { status: "unanswered" },
    });
    const unanswered = await raw.call("submission", { conversationId, requestId: "queued" });
    expect(valueOf<SubmissionReply>(unanswered).entry).toBeUndefined();

    finishBusy();
    await settled(client, "busy done");
  });

  it("keeps an admitted submit ok when reading the record afterwards fails", async () => {
    const host = await startFauxHost(defer, { answers: ["started", "accepted"] });
    const client = await connectTo(defer, host);
    const conversationId = await startChat(client, "start");
    await settled(client, "started");
    const raw = await rawClient(host);

    const read = vi.spyOn(host.harness, "submission").mockRejectedValueOnce(new Error("storage read failed"));
    const accepted = await raw.call("submit", {
      conversationId,
      text: "accepted",
      whenBusy: "followUp",
      requestId: "admitted",
    });
    expect(accepted).toMatchObject({ ok: true, value: { submissionId: expect.any(Number) } });
    const acceptedReply = valueOf<SubmissionReply>(accepted);
    expect(acceptedReply).not.toHaveProperty("entry");
    expect(read).toHaveBeenCalledTimes(1);
    read.mockRestore();

    // Admission really happened: the record is there with its entry.
    expect(await raw.call("submission", { conversationId, requestId: "admitted" })).toMatchObject({
      ok: true,
      value: { status: "placed", entry: expect.any(Number) },
    });
  });

  it("admits concurrent submits with one request id once", async () => {
    const host = await startFauxHost(defer, { answers: ["started", "one done"] });
    const client = await connectTo(defer, host);
    const conversationId = await startChat(client, "start");
    await settled(client, "started");
    const raw = await rawClient(host);
    const attachmentId = await upload(client, "notes.txt", "hello");

    let entered!: () => void;
    const firstReachedPreprocessing = new Promise<void>((resolve) => (entered = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const originalUse = AttachmentStore.prototype.use;
    let uses = 0;
    const use = vi.spyOn(AttachmentStore.prototype, "use").mockImplementation(async function (this: AttachmentStore, ids) {
      uses += 1;
      if (uses === 1) {
        entered();
        await gate;
      }
      return originalUse.call(this, ids);
    });
    defer(() => use.mockRestore());

    const first = raw.call("submit", {
      conversationId,
      text: "one",
      whenBusy: "followUp",
      requestId: "same",
      attachments: [attachmentId],
    });
    await firstReachedPreprocessing;

    const second = raw.call("submit", {
      conversationId,
      text: "two",
      whenBusy: "followUp",
      requestId: "same",
      attachments: [attachmentId],
    });
    // Ping is the barrier: the socket feeds it after the second submit, so the
    // host has read the message. A serialized second waits on the first key.
    expect(await raw.call("ping", { id: "barrier" })).toMatchObject({ ok: true, value: { id: "barrier" } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(uses).toBe(1);

    release();
    const [one, two] = await Promise.all([first, second]);
    expect(one.ok && two.ok).toBe(true);
    expect(valueOf<SubmissionReply>(two)).toEqual(valueOf<SubmissionReply>(one));
    expect(uses).toBe(1);
    expect(await raw.call("submission", { conversationId, requestId: "same" })).toMatchObject({
      ok: true,
      value: { submissionId: valueOf<SubmissionReply>(one).submissionId, status: "placed" },
    });
    await settled(client, "one done");
    const sent = userTexts(client);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toBe("start");
    expect(sent[1]!.startsWith("one")).toBe(true);
    expect(sent.some((text) => text.includes("two"))).toBe(false);
  });
});