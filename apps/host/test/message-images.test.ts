// Message images (protocol 5.5): submit/createConversation carry base64 image
// blocks, the host validates them with imageProblem before anything is written,
// and pi.user entries store them as content blocks.
import { once } from "node:events";
import { fauxAssistantMessage, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationView } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord";
import { WebSocket } from "ws";
import { describe, expect, it } from "vitest";
import { isBusy, transcript } from "@pinomad/protocol/transcript.ts";
import type { ServerFrame } from "@pinomad/protocol/frames.ts";
import { MAX_IMAGE_BYTES } from "@pinomad/protocol/images.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import { connectTo, inlineImages, startChat, startFauxHost, tempDir, useCleanups, waitForView } from "./support.ts";

const defer = useCleanups();
const PNG = { data: "aGVsbG8=", mimeType: "image/png" as const };

/** A bare socket on the host, for frames the controller doesn't send yet. */
async function rawClient(host: { url: string; token: string }) {
  const socket = new WebSocket(`${host.url}?token=${encodeURIComponent(host.token)}`);
  defer(() => socket.terminate());
  const frames: ServerFrame[] = [];
  const waiters = new Set<() => void>();
  socket.on("message", (data) => {
    frames.push(JSON.parse(String(data)) as ServerFrame);
    for (const wake of waiters) wake();
  });
  await once(socket, "open");
  const next = (match: (frame: ServerFrame) => boolean): Promise<ServerFrame> =>
    new Promise((resolve) => {
      const check = (): void => {
        const found = frames.find(match);
        if (found === undefined) return;
        waiters.delete(check);
        resolve(found);
      };
      waiters.add(check);
      check();
    });
  let ids = 0;
  return {
    send: (frame: unknown): void => socket.send(JSON.stringify(frame)),
    next,
    async call(method: string, args: unknown): Promise<{ ok: boolean; value?: unknown; error?: string }> {
      const id = ++ids;
      socket.send(JSON.stringify({ type: "call", id, method, args }));
      const { ok, ...rest } = (await next((frame) => frame.type === "result" && frame.id === id)) as ServerFrame & { type: "result" };
      return ok ? { ok, value: (rest as { value: unknown }).value } : { ok, error: (rest as { error: string }).error };
    },
  };
}

/** Every pi.user entry's stored message content, in order. */
const userContents = (view: ConversationView): readonly (JsonValue | undefined)[] =>
  view.entries
    .filter((entry) => entry.kind === "pi.user")
    .map((entry) => (entry.model?.[0] as { content?: JsonValue } | undefined)?.content);

/** The same contents with ref image blocks resolved through the client. */
async function inlineUserContents(client: RemoteDurable, view: ConversationView): Promise<unknown[]> {
  return Promise.all(
    userContents(view).map((content) => (Array.isArray(content) ? inlineImages(client, content) : content)),
  );
}

/** The first image block's ref in a ref-mode conversation snapshot. */
const firstRef = (snapshot: ServerFrame): string => {
  const content = userContents((snapshot as { value: ConversationView }).value)[0];
  return (content as { ref?: string }[]).find((block) => block.ref !== undefined)!.ref!;
};

describe("message images", () => {
  it("stores text and image blocks on a submit", async () => {
    const host = await startFauxHost(defer, { answers: ["first", "seen"] });
    const client = await connectTo(defer, host);
    await startChat(client, "hi");
    await waitForView(client.view, (view) => transcript(view.conversation!).at(-1)?.text === "first");

    await client.controller.submit("look", "followUp", { images: [PNG] });
    await waitForView(client.view, (view) => transcript(view.conversation!).at(-1)?.text === "seen");

    expect(await inlineUserContents(client, client.view.current().conversation!)).toEqual([
      "hi",
      [
        { type: "text", text: "look" },
        { type: "image", data: PNG.data, mimeType: "image/png" },
      ],
    ]);
  });

  it("creates a conversation from an image-only message and gives it no title", async () => {
    const host = await startFauxHost(defer, { answers: ["seen"] });
    const client = await connectTo(defer, host);
    await client.controller.createConversation({ kind: "chat" }, "", { images: [PNG] });
    await waitForView(client.view, (view) => transcript(view.conversation!).at(-1)?.text === "seen");

    const summary = client.view.current().organized.chats[0]!.summary;
    expect(await inlineUserContents(client, client.view.current().conversation!)).toEqual([
      [{ type: "image", data: PNG.data, mimeType: "image/png" }],
    ]);
    // No text in the first message → no title rather than an empty one.
    expect(summary.title).toBeUndefined();
  });

  it("queues a busy followUp with its image and places it after the run", async () => {
    let finish!: (message: ReturnType<typeof fauxAssistantMessage>) => void;
    const gate = new Promise<ReturnType<typeof fauxAssistantMessage>>((resolve) => (finish = resolve));
    const blocked: FauxResponseFactory = () => gate;
    const host = await startFauxHost(defer, { answers: [blocked, "second answer"] });
    const client = await connectTo(defer, host);
    await startChat(client, "first");
    await waitForView(client.view, (view) => view.conversation !== undefined && isBusy(view.conversation));

    await client.controller.submit("later", "followUp", { images: [PNG] });
    finish(fauxAssistantMessage("first answer"));
    await waitForView(client.view, (view) => transcript(view.conversation!).at(-1)?.text === "second answer");

    expect((await inlineUserContents(client, client.view.current().conversation!)).at(-1)).toEqual([
      { type: "text", text: "later" },
      { type: "image", data: PNG.data, mimeType: "image/png" },
    ]);
  });

  it("rejects images that fail validation without writing an entry", async () => {
    const host = await startFauxHost(defer, { answers: ["done"] });
    const client = await connectTo(defer, host);
    const id = await startChat(client, "hi");
    await waitForView(client.view, (view) => transcript(view.conversation!).at(-1)?.text === "done");

    // Raw call frames: controller.submit resolves void and its rejection is a
    // notice — the verdict only exists on the result frame.
    const socket = new WebSocket(`${host.url}?token=${encodeURIComponent(host.token)}`);
    defer(() => socket.terminate());
    const results = new Map<number, string>();
    socket.on("message", (data) => {
      const frame = JSON.parse(String(data)) as ServerFrame;
      if (frame.type === "result" && !frame.ok) results.set(frame.id, frame.error);
    });
    await once(socket, "open");
    const submit = (callId: number, images: unknown): void =>
      socket.send(
        JSON.stringify({
          type: "call",
          id: callId,
          method: "submit",
          args: { conversationId: id, text: "again", whenBusy: "followUp", requestId: `bad:${callId}`, images },
        }),
      );
    const tooBig = "A".repeat(((MAX_IMAGE_BYTES + 1) * 4) / 3); // > 5 MB decoded
    submit(1, [PNG, PNG, PNG, PNG, PNG]);
    submit(2, [{ data: "AAAA", mimeType: "image/heic" }]);
    submit(3, [{ data: tooBig, mimeType: "image/png" }]);
    await expect.poll(() => results.size).toBe(3);
    expect(results.get(1)).toBe("At most 4 images per message");
    expect(results.get(2)).toBe("Unsupported image type: image/heic (use JPEG, PNG, GIF or WebP)");
    expect(results.get(3)).toBe("Image 1 is larger than 5 MB");

    // Nothing was admitted: the transcript is still just the first pair.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(transcript(client.view.current().conversation!).map((m) => m.text)).toEqual(["hi", "done"]);
  });

  it("keeps the text fallback title of an image-only-first conversation across a restart", async () => {
    const dir = await tempDir();
    defer(dir.remove);
    const first = await startFauxHost(defer, { dataDir: dir.path, answers: ["seen", "done"] });
    const client = await connectTo(defer, first);
    await client.controller.createConversation({ kind: "chat" }, "", { images: [PNG] });
    await waitForView(client.view, (view) => transcript(view.conversation!).at(-1)?.text === "seen");

    // The first message with text supplies the fallback title.
    await client.controller.submit("Continue", "followUp");
    await waitForView(client.view, (view) => view.organized.chats[0]?.summary.title === "Continue");
    client.close();
    await first.close();

    // On restart the summary is derived from the entry scan — same rule.
    const second = await startFauxHost(defer, { dataDir: dir.path });
    const after = await connectTo(defer, second);
    await waitForView(after.view, (view) => view.organized.chats[0]?.summary.title === "Continue");
  });

  it("sends refs to an images: \"ref\" subscription, answers their bytes, and takes them back on submit", async () => {
    const host = await startFauxHost(defer, { answers: ["seen", "again"] });
    const client = await connectTo(defer, host);
    await client.controller.createConversation({ kind: "chat" }, "look", { images: [PNG] });
    await waitForView(client.view, (view) => transcript(view.conversation!).at(-1)?.text === "seen");
    const id = client.view.current().conversation!.conversation.id;

    const raw = await rawClient(host);
    raw.send({ type: "subscribe", stream: `conversation:${id}`, images: "ref" });
    const snapshot = await raw.next((frame) => frame.type === "snapshot" && frame.stream === `conversation:${id}`);
    const shown = userContents((snapshot as { value: ConversationView }).value)[0] as { ref?: string; data?: string }[];
    expect(shown[1]).toEqual({ type: "image", mimeType: "image/png", ref: expect.any(String) });
    expect(JSON.stringify(snapshot)).not.toContain(PNG.data);
    const ref = shown[1]!.ref!;

    expect(await raw.call("image", { ref })).toEqual({ ok: true, value: PNG });
    expect(await raw.call("image", { ref: "nope" })).toEqual({ ok: false, error: "Unknown image" });

    // A retry sends only the ref back; the host remembers the type with the bytes.
    expect(
      await raw.call("submit", { conversationId: id, text: "again", whenBusy: "followUp", requestId: "r2", images: [{ ref }] }),
    ).toMatchObject({ ok: true });
    await waitForView(client.view, (view) => transcript(view.conversation!).at(-1)?.text === "again");
    expect((await inlineUserContents(client, client.view.current().conversation!)).at(-1)).toEqual([
      { type: "text", text: "again" },
      { type: "image", data: PNG.data, mimeType: "image/png" },
    ]);
    expect(
      await raw.call("submit", { conversationId: id, text: "x", whenBusy: "followUp", requestId: "r3", images: [{ ref: "nope" }] }),
    ).toEqual({ ok: false, error: "Image 1 is no longer available" });

    // Unsubscribed, the connection no longer vouches for the ref.
    raw.send({ type: "unsubscribe", stream: `conversation:${id}` });
    await expect.poll(async () => (await raw.call("image", { ref })).ok).toBe(false);
  });

  it("answers a request issued before clearConversation and refuses new ones until shown again", async () => {
    const host = await startFauxHost(defer, { answers: ["seen"] });
    const client = await connectTo(defer, host);
    await client.controller.createConversation({ kind: "chat" }, "look", { images: [PNG] });
    await waitForView(client.view, (view) => transcript(view.conversation!).at(-1)?.text === "seen");
    const id = client.view.current().conversation!.conversation.id;
    const ref = (userContents(client.view.current().conversation!)[0] as { ref?: string }[]).find(
      (block) => block.ref !== undefined,
    )!.ref!;

    // The call frame already left; clearing only drops the subscription that
    // authorized it on the host, so the host still answers this one.
    const pending = client.controller.image(ref);
    await client.controller.clearConversation();
    expect(client.view.current().conversation).toBeUndefined();
    await expect(pending).resolves.toEqual(PNG);

    // A fresh request has no live ref subscription behind it (ADR-0027: the
    // host authorizes by current view), so it is refused until the
    // conversation is shown again.
    await expect(client.controller.image(ref)).rejects.toThrow("Unknown image");
    await client.controller.switchConversation(id);
    await expect(client.controller.image(ref)).resolves.toEqual(PNG);
  });

  it("resolves a submitted ref before its first await, so an immediate unsubscribe cannot invalidate it", async () => {
    const host = await startFauxHost(defer, { answers: ["seen", "again"] });
    const client = await connectTo(defer, host);
    await client.controller.createConversation({ kind: "chat" }, "look", { images: [PNG] });
    await waitForView(client.view, (view) => transcript(view.conversation!).at(-1)?.text === "seen");
    const id = client.view.current().conversation!.conversation.id;

    const raw = await rawClient(host);
    raw.send({ type: "subscribe", stream: `conversation:${id}`, images: "ref" });
    const snapshot = await raw.next((frame) => frame.type === "snapshot" && frame.stream === `conversation:${id}`);
    const ref = firstRef(snapshot);

    // The submit frame lands while the subscription is live; the unsubscribe
    // follows immediately and may finish while the host is still reading the
    // conversation. The ref has to be resolved before that await.
    const pending = raw.call("submit", { conversationId: id, text: "again", whenBusy: "followUp", requestId: "race", images: [{ ref }] });
    raw.send({ type: "unsubscribe", stream: `conversation:${id}` });
    expect(await pending).toMatchObject({ ok: true });
    await waitForView(client.view, (view) => transcript(view.conversation!).at(-1)?.text === "again");
    expect((await inlineUserContents(client, client.view.current().conversation!)).at(-1)).toEqual([
      { type: "text", text: "again" },
      { type: "image", data: PNG.data, mimeType: "image/png" },
    ]);
  });

  it("does not honor another connection's refs until that connection subscribes", async () => {
    const host = await startFauxHost(defer, { answers: ["seen", "again"] });
    const client = await connectTo(defer, host);
    await client.controller.createConversation({ kind: "chat" }, "look", { images: [PNG] });
    await waitForView(client.view, (view) => transcript(view.conversation!).at(-1)?.text === "seen");
    const id = client.view.current().conversation!.conversation.id;

    const first = await rawClient(host);
    first.send({ type: "subscribe", stream: `conversation:${id}`, images: "ref" });
    const snapshot = await first.next((frame) => frame.type === "snapshot" && frame.stream === `conversation:${id}`);
    const ref = firstRef(snapshot);

    const second = await rawClient(host);
    expect(await second.call("image", { ref })).toEqual({ ok: false, error: "Unknown image" });
    expect(
      await second.call("submit", { conversationId: id, text: "x", whenBusy: "followUp", requestId: "b1", images: [{ ref }] }),
    ).toEqual({ ok: false, error: "Image 1 is no longer available" });

    second.send({ type: "subscribe", stream: `conversation:${id}`, images: "ref" });
    await second.next((frame) => frame.type === "snapshot" && frame.stream === `conversation:${id}`);
    expect(await second.call("image", { ref })).toEqual({ ok: true, value: PNG });
    expect(
      await second.call("submit", { conversationId: id, text: "again", whenBusy: "followUp", requestId: "b2", images: [{ ref }] }),
    ).toMatchObject({ ok: true });
  });

  it("takes a ref on createConversation before the first await", async () => {
    const host = await startFauxHost(defer, { answers: ["seen", "again"] });
    const client = await connectTo(defer, host);
    await client.controller.createConversation({ kind: "chat" }, "look", { images: [PNG] });
    await waitForView(client.view, (view) => transcript(view.conversation!).at(-1)?.text === "seen");
    const source = client.view.current().conversation!.conversation.id;

    const raw = await rawClient(host);
    raw.send({ type: "subscribe", stream: `conversation:${source}`, images: "ref" });
    const snapshot = await raw.next((frame) => frame.type === "snapshot" && frame.stream === `conversation:${source}`);
    const ref = firstRef(snapshot);

    // Resolve the ref before createConversation's first await, just like submit.
    const pending = raw.call("createConversation", {
      home: { kind: "chat" },
      text: "from ref",
      requestId: "create-ref",
      images: [{ ref }],
    });
    raw.send({ type: "unsubscribe", stream: `conversation:${source}` });
    const created = await pending;
    expect(created).toMatchObject({ ok: true });
    const id = (created.value as { conversationId: number }).conversationId;

    raw.send({ type: "subscribe", stream: `conversation:${id}`, images: "ref" });
    const after = await raw.next((frame) => frame.type === "snapshot" && frame.stream === `conversation:${id}`);
    expect(userContents((after as { value: ConversationView }).value)[0]).toEqual([
      { type: "text", text: "from ref" },
      { type: "image", mimeType: "image/png", ref: expect.any(String) },
    ]);
  });

  it("keeps a ref valid while another live subscription still shows the image", async () => {
    const host = await startFauxHost(defer, { answers: ["one", "two"] });
    const raw = await rawClient(host);
    const create = async (requestId: string): Promise<number> => {
      const result = await raw.call("createConversation", {
        home: { kind: "chat" },
        text: requestId,
        requestId,
        images: [PNG],
      });
      return (result.value as { conversationId: number }).conversationId;
    };
    const first = await create("c1");
    const second = await create("c2");
    const subscribe = async (id: number): Promise<ServerFrame> => {
      raw.send({ type: "subscribe", stream: `conversation:${id}`, images: "ref" });
      return await raw.next((frame) => frame.type === "snapshot" && frame.stream === `conversation:${id}`);
    };
    const firstSnapshot = await subscribe(first);
    const secondSnapshot = await subscribe(second);
    const ref = firstRef(firstSnapshot);
    expect(firstRef(secondSnapshot)).toBe(ref);

    raw.send({ type: "unsubscribe", stream: `conversation:${first}` });
    expect(await raw.call("image", { ref })).toEqual({ ok: true, value: PNG });

    raw.send({ type: "unsubscribe", stream: `conversation:${second}` });
    await expect.poll(async () => (await raw.call("image", { ref })).ok).toBe(false);
  });

  it("shares derived images only after each connection proves the original ref", async () => {
    let preparations = 0;
    let release!: (image: { data: string; mimeType: string }) => void;
    const blocked = new Promise<{ data: string; mimeType: string }>((resolve) => (release = resolve));
    const host = await startFauxHost(defer, {
      answers: ["seen"],
      images: {
        prepare: async () => {
          preparations += 1;
          if (preparations === 2) return await blocked;
          return { data: "VEhVTUI=", mimeType: "image/jpeg" };
        },
      },
    });
    const client = await connectTo(defer, host);
    await client.controller.createConversation({ kind: "chat" }, "look", { images: [PNG] });
    await waitForView(client.view, (view) => transcript(view.conversation!).at(-1)?.text === "seen");
    const id = client.view.current().conversation!.conversation.id;

    const first = await rawClient(host);
    first.send({ type: "subscribe", stream: `conversation:${id}`, images: "ref" });
    const snapshot = await first.next((frame) => frame.type === "snapshot" && frame.stream === `conversation:${id}`);
    const ref = firstRef(snapshot);
    const thumbnail = { data: "VEhVTUI=", mimeType: "image/jpeg", variant: "thumbnail" };
    expect(await first.call("image", { ref, variant: "thumbnail" })).toEqual({ ok: true, value: thumbnail });
    expect(await first.call("image", { ref })).toEqual({ ok: true, value: PNG });

    const second = await rawClient(host);
    expect(await second.call("image", { ref, variant: "thumbnail" })).toEqual({ ok: false, error: "Unknown image" });
    second.send({ type: "subscribe", stream: `conversation:${id}`, images: "ref" });
    await second.next((frame) => frame.type === "snapshot" && frame.stream === `conversation:${id}`);
    expect(await second.call("image", { ref, variant: "thumbnail" })).toEqual({ ok: true, value: thumbnail });
    expect(preparations).toBe(1);

    const pending = second.call("image", { ref, variant: "preview" });
    await expect.poll(() => preparations).toBe(2);
    second.send({ type: "unsubscribe", stream: `conversation:${id}` });
    await expect.poll(async () => (await second.call("image", { ref })).ok).toBe(false);
    release({ data: "UFJFVklFVw==", mimeType: "image/jpeg" });
    expect(await pending).toEqual({ ok: false, error: "Unknown image" });
  });

  it("keeps sending image bytes inline to a subscription that didn't ask for refs", async () => {
    const host = await startFauxHost(defer, { answers: ["seen"] });
    const client = await connectTo(defer, host);
    await client.controller.createConversation({ kind: "chat" }, "look", { images: [PNG] });
    await waitForView(client.view, (view) => transcript(view.conversation!).at(-1)?.text === "seen");
    const id = client.view.current().conversation!.conversation.id;

    const raw = await rawClient(host);
    raw.send({ type: "subscribe", stream: `conversation:${id}` });
    const snapshot = await raw.next((frame) => frame.type === "snapshot" && frame.stream === `conversation:${id}`);
    expect(userContents((snapshot as { value: ConversationView }).value)[0]).toEqual([
      { type: "text", text: "look" },
      { type: "image", data: PNG.data, mimeType: "image/png" },
    ]);
  });

  it("reports model image support in the models stream", async () => {
    const host = await startFauxHost(defer, {
      answers: [],
      fauxModels: [
        { id: "faux-1", name: "Faux One" },
        { id: "faux-text", name: "Faux Text", input: ["text"] },
      ],
    });
    const client = await connectTo(defer, host);
    await waitForView(client.view, (view) => view.models.length === 2);
    const models = client.view.current().models;
    expect(models.find((model) => model.modelId === "faux-1")?.images).toBe(true);
    expect(models.find((model) => model.modelId === "faux-text")?.images).toBe(false);
  });
});
