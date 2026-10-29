// File attachments over the gateway (issue #321): unbound uploads, the v1
// block the model reads, permanent `used` references, and the errors a client
// can tell apart.
import { once } from "node:events";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { ConversationView } from "@earendil-works/pi-durable";
import { WebSocket } from "ws";
import { describe, expect, it } from "vitest";
import { attachmentBlock, parseAttachmentBlock, xmlAttribute } from "@pinomad/protocol/attachments.ts";
import type { ServerFrame } from "@pinomad/protocol/frames.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import { isBusy, transcript } from "@pinomad/protocol/transcript.ts";
import { connectTo, startChat, startFauxHost, tempDir, useCleanups, waitForView } from "./support.ts";

const defer = useCleanups();

interface Raw {
  call(method: string, args: unknown): Promise<{ ok: boolean; value?: unknown; error?: string }>;
  close(): void;
}

async function rawClient(host: { url: string; token: string }): Promise<Raw> {
  const socket = new WebSocket(`${host.url}?token=${encodeURIComponent(host.token)}`);
  const pending = new Map<number, (value: { ok: boolean; value?: unknown; error?: string }) => void>();
  let next = 0;
  socket.on("message", (data) => {
    const frame = JSON.parse(String(data)) as ServerFrame;
    if (frame.type !== "result") return;
    pending.get(frame.id)?.(frame.ok ? { ok: true, value: frame.value } : { ok: false, error: frame.error });
    pending.delete(frame.id);
  });
  await once(socket, "open");
  return {
    call: (method, args) =>
      new Promise((resolve) => {
        const id = ++next;
        pending.set(id, resolve);
        socket.send(JSON.stringify({ type: "call", id, method, args }));
      }),
    close: () => socket.terminate(),
  };
}

function userContents(view: ConversationView): unknown[] {
  const entry = view.entries.filter((candidate) => candidate.kind === "pi.user").at(-1);
  return entry?.model?.[0]?.content as unknown[];
}

async function upload(client: RemoteDurable, name: string, text: string): Promise<string> {
  const bytes = Buffer.from(text);
  const id = await client.controller.beginAttachment(name, bytes.length);
  expect(await client.controller.appendAttachment(id, 0, bytes.toString("base64"))).toEqual({
    received: bytes.length,
    complete: true,
  });
  return id;
}

describe("gateway attachments", () => {
  it("stores the uploaded bytes and writes the escaped v1 block before the images", async () => {
    const host = await startFauxHost(defer, { answers: ["done", "again", "third"] });
    const client = await connectTo(defer, host);
    const chat = await startChat(client, "hi");
    await waitForView(client.view, (view) => transcript(view.conversation!).at(-1)?.text === "done");

    const id = await upload(client, 'a&b<c>d"e.txt', "hello");
    await client.controller.submit("look", "followUp", { attachments: [id] });
    await waitForView(client.view, (view) => transcript(view.conversation!).at(-1)?.text === "again");

    const content = userContents(client.view.current().conversation!) as { type: string; text: string }[];
    expect(content[0]).toEqual({ type: "text", text: "look" });
    expect(content[1]?.type).toBe("text");
    expect(content[1]!.text).toContain('name="a&amp;b&lt;c&gt;d&quot;e.txt"');
    expect(content[1]!.text).toContain('size="5"');
    expect(parseAttachmentBlock(content[1]!.text)).toEqual([{ id, name: 'a&b<c>d"e.txt', size: 5 }]);
    // The path is the host's absolute attachment path, XML-escaped like every attribute.
    const escapedPath = / path="([^"]*)"/.exec(content[1]!.text)?.[1];
    expect(escapedPath).toContain(`/attachments/${id}/`);
    expect(escapedPath).toContain(xmlAttribute('a&b<c>d"e.txt'));
    expect(isBusy(client.view.current().conversation!)).toBe(false);

    // `used` is permanent and the same id can be sent again.
    await client.controller.submit("same file", "followUp", { attachments: [id] });
    await waitForView(client.view, (view) => transcript(view.conversation!).at(-1)?.text === "third");
    expect(userContents(client.view.current().conversation!)[1]).toMatchObject({ type: "text" });
    expect(chat).toBe(client.view.current().conversation!.conversation.id);
  });

  it("finishes an upload started before clearConversation and submits it by fixed target", async () => {
    const host = await startFauxHost(defer, { answers: ["done", "again"] });
    const client = await connectTo(defer, host);
    const chat = await startChat(client, "hi");
    await waitForView(client.view, (view) => transcript(view.conversation!).at(-1)?.text === "done");

    const bytes = Buffer.from("hello");
    const id = await client.controller.beginAttachment("a.txt", bytes.length);
    await client.controller.clearConversation();
    expect(client.view.current().conversation).toBeUndefined();
    // Uploads belong to the connection, not to the released subscription.
    expect(await client.controller.appendAttachment(id, 0, bytes.toString("base64"))).toEqual({
      received: bytes.length,
      complete: true,
    });
    await client.controller.submit("look", "followUp", { target: chat, attachments: [id] });
    await client.controller.switchConversation(chat);
    await waitForView(client.view, (view) => transcript(view.conversation!).at(-1)?.text === "again");
    expect(parseAttachmentBlock((userContents(client.view.current().conversation!)[1] as { text: string }).text)).toEqual([
      { id, name: "a.txt", size: bytes.length },
    ]);
  });

  it("derives the fallback title from text blocks only", async () => {
    const host = await startFauxHost(defer, { answers: ["seen", "again"] });
    const client = await connectTo(defer, host);
    const id = await upload(client, "notes.txt", "hello");
    await client.controller.createConversation({ kind: "chat" }, "look at the notes", { attachments: [id] });
    await waitForView(client.view, (view) => transcript(view.conversation!).at(-1)?.text === "seen");
    const titled = client.view.current().conversation!.conversation.id;
    expect(client.view.current().organized.chats.find((chat) => chat.summary.id === titled)?.summary.title).toBe(
      "look at the notes",
    );

    // A string that happens to be a valid block is regular text: the host only
    // skips a whole attachment text block, not a substring.
    const block = attachmentBlock([{ id: "A".repeat(22), name: "pasted.txt", path: "/tmp/pasted.txt", size: 1 }]);
    await client.controller.createConversation({ kind: "chat" }, block);
    await waitForView(client.view, (view) => view.organized.chats.some((chat) => chat.summary.title?.includes("<attachments")));
    const stringTitle = client.view.current().organized.chats.find((chat) => chat.summary.title?.includes("<attachments"));
    expect(stringTitle?.summary.title).toBe(block.replace(/\s+/g, " ").trim());
  });

  it("leaves an attachment-only first message untitled until text arrives", async () => {
    const host = await startFauxHost(defer, { answers: ["seen", "later"] });
    const client = await connectTo(defer, host);
    const id = await upload(client, "only.log", "hello");
    await client.controller.createConversation({ kind: "chat" }, "", { attachments: [id] });
    await waitForView(client.view, (view) => transcript(view.conversation!).at(-1)?.text === "seen");
    // The fallback title reads the typed text, not the host's <attachments> block.
    expect(client.view.current().organized.chats[0]?.summary.title).toBeUndefined();
    await client.controller.submit("Continue", "followUp");
    await waitForView(client.view, (view) => view.organized.chats.map((chat) => chat.summary.title).includes("Continue"));
  });

  it("creates a conversation whose only content is an attachments block", async () => {
    const host = await startFauxHost(defer, { answers: ["seen"] });
    const client = await connectTo(defer, host);
    const id = await upload(client, "empty.txt", "");
    await client.controller.createConversation({ kind: "chat" }, "", { attachments: [id] });
    await waitForView(client.view, (view) => transcript(view.conversation!).at(-1)?.text === "seen");
    const content = userContents(client.view.current().conversation!) as { type: string; text: string }[];
    expect(content).toHaveLength(1);
    expect(parseAttachmentBlock(content[0]!.text)).toEqual([{ id, name: "empty.txt", size: 0 }]);
  });

  it("separates expired, still-uploading, and damaged attachments", async () => {
    const dir = await tempDir();
    defer(dir.remove);
    const host = await startFauxHost(defer, { dataDir: dir.path, answers: ["seen"] });
    const client = await connectTo(defer, host);
    const chat = await startChat(client, "hi");
    await waitForView(client.view, (view) => transcript(view.conversation!).at(-1)?.text === "seen");

    const raw = await rawClient(host);
    defer(() => raw.close());
    const begin = async (name: string, size: number): Promise<string> =>
      ((await raw.call("beginAttachment", { name, size })).value as { attachmentId: string }).attachmentId;
    const submit = (attachments: string[]) =>
      raw.call("submit", {
        conversationId: chat,
        text: "again",
        whenBusy: "followUp",
        requestId: `attach:${Math.random()}`,
        attachments,
      });

    const uploading = await begin("up.txt", 5);
    expect(await submit([uploading])).toEqual({ ok: false, error: "Attachment 1 is still uploading" });

    const expired = await begin("gone.txt", 0);
    await rm(join(dir.path, "attachments", expired, "meta.json"));
    expect(await submit([expired])).toMatchObject({ ok: false, error: expect.stringMatching(/expired/) });

    expect(await submit(Array.from({ length: 11 }, () => uploading))).toMatchObject({
      ok: false,
      error: "At most 10 attachments per message",
    });
  });
});
