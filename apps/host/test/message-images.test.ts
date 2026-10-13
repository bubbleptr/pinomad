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
import { connectTo, startChat, startFauxHost, tempDir, useCleanups, waitForView } from "./support.ts";

const defer = useCleanups();
const PNG = { data: "aGVsbG8=", mimeType: "image/png" as const };

/** Every pi.user entry's stored message content, in order. */
const userContents = (view: ConversationView): readonly (JsonValue | undefined)[] =>
  view.entries
    .filter((entry) => entry.kind === "pi.user")
    .map((entry) => (entry.model?.[0] as { content?: JsonValue } | undefined)?.content);

describe("message images", () => {
  it("stores text and image blocks on a submit", async () => {
    const host = await startFauxHost(defer, { answers: ["first", "seen"] });
    const client = await connectTo(defer, host);
    await startChat(client, "hi");
    await waitForView(client.view, (view) => transcript(view.conversation!).at(-1)?.text === "first");

    await client.controller.submit("look", "followUp", { images: [PNG] });
    await waitForView(client.view, (view) => transcript(view.conversation!).at(-1)?.text === "seen");

    expect(userContents(client.view.current().conversation!)).toEqual([
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
    expect(userContents(client.view.current().conversation!)).toEqual([
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

    expect(userContents(client.view.current().conversation!).at(-1)).toEqual([
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
