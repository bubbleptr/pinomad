import { once } from "node:events";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, ConversationView, EntryDraft, EntryRecord } from "@earendil-works/pi-durable";
import { WebSocket } from "ws";
import { describe, expect, it } from "vitest";
import type { ServerFrame } from "@pinomad/protocol/frames.ts";
import { isBusy } from "@pinomad/protocol/transcript.ts";
import { connectTo, startChat, startFauxHost, useCleanups, waitForView } from "./support.ts";

const defer = useCleanups();
const context = BACKGROUND_CONTEXT;

type Host = Awaited<ReturnType<typeof startFauxHost>>;
type Result = { ok: boolean; value?: unknown; error?: string };

const user = (text: string): EntryDraft => ({ kind: "pi.user", model: [{ role: "user", content: text, timestamp: 0 }] });
const assistant = (text: string): EntryDraft => ({
  kind: "pi.assistant",
  model: [{
    role: "assistant",
    content: [{ type: "text", text }],
    api: "faux",
    provider: "faux",
    model: "faux-1",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: 0,
  }],
});

/** A finished chat plus `drafts`, committed in one go; returns the conversation and all its entry ids, oldest first. */
async function longChat(host: Host, drafts: readonly EntryDraft[]): Promise<{ id: ConversationId; ids: number[] }> {
  const writer = await connectTo(defer, host);
  const id = await startChat(writer, "first");
  await waitForView(writer.view, (view) => !isBusy(view.conversation!));
  await host.harness.commit(async (tx) => {
    for (const draft of drafts) await tx.appendEntry(id, draft);
  }, context);
  const conversation = await host.harness.conversation(id, context);
  const page = await conversation!.entries({ order: "ascending" }, 10_000, undefined, context);
  return { id, ids: page.items.map((entry) => entry.id as number) };
}

/** A socket speaking raw frames: the gateway's window and `earlierEntries` without the client SDK in between. */
async function raw(host: Host) {
  const socket = new WebSocket(`${host.url}?token=${encodeURIComponent(host.token)}`);
  defer(() => socket.terminate());
  const frames: ServerFrame[] = [];
  const pending = new Map<number, (result: Result) => void>();
  let next = 0;
  socket.on("message", (data) => {
    const frame = JSON.parse(String(data)) as ServerFrame;
    frames.push(frame);
    if (frame.type !== "result") return;
    pending.get(frame.id)?.(frame.ok ? { ok: true, value: frame.value } : { ok: false, error: frame.error });
    pending.delete(frame.id);
  });
  await once(socket, "open");
  return {
    send: (frame: unknown) => socket.send(JSON.stringify(frame)),
    call: (method: string, args: unknown) =>
      new Promise<Result>((resolve) => {
        const id = ++next;
        pending.set(id, resolve);
        socket.send(JSON.stringify({ type: "call", id, method, args }));
      }),
    snapshot: async (stream: string): Promise<ConversationView> => {
      const deadline = Date.now() + 10_000;
      for (;;) {
        const frame = frames.find((candidate) => candidate.type === "snapshot" && candidate.stream === stream);
        if (frame?.type === "snapshot") return frame.value as ConversationView;
        if (Date.now() > deadline) throw new Error(`no snapshot on ${stream}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
  };
}

type Page = { entries: EntryRecord[]; before?: number };

describe("long transcript", () => {
  it("streams every entry when the subscribe asks for no window", async () => {
    const host = await startFauxHost(defer);
    const { id, ids } = await longChat(host, Array.from({ length: 150 }, (_, index) => user(`m${index}`)));

    const client = await raw(host);
    client.send({ type: "subscribe", stream: `conversation:${id}` });
    const view = await client.snapshot(`conversation:${id}`);
    expect(view.entries.map((entry) => entry.id)).toEqual(ids);
    expect(view.before).toBeUndefined();
  });

  it("bounds the first snapshot by the window and pages the rest back with earlierEntries", async () => {
    const host = await startFauxHost(defer);
    const { id, ids } = await longChat(host, Array.from({ length: 150 }, (_, index) => user(`m${index}`)));

    const client = await raw(host);
    client.send({ type: "subscribe", stream: `conversation:${id}`, window: { limit: 20 } });
    const view = await client.snapshot(`conversation:${id}`);
    expect(view.entries.map((entry) => entry.id)).toEqual(ids.slice(-20));
    expect(view.before).toBe(ids.at(-21));

    const pages: Page[] = [];
    let before: number | undefined = view.before as number;
    while (before !== undefined) {
      const result = await client.call("earlierEntries", { conversationId: id, before, limit: 50 });
      expect(result.ok).toBe(true);
      const page = result.value as Page;
      expect(page.entries.length).toBeGreaterThan(0);
      expect(page.entries.at(-1)!.id).toBe(before);
      pages.unshift(page);
      before = page.before;
    }
    expect([...pages.flatMap((page) => page.entries), ...view.entries].map((entry) => entry.id)).toEqual(ids);
  });

  it("starts the window and each page at a turn, never inside a run", async () => {
    const host = await startFauxHost(defer);
    // Turns of one user message and 30 assistant entries: a limit of 10 lands inside a run.
    const drafts = Array.from({ length: 4 }, (_, turn) => [user(`u${turn}`), ...Array.from({ length: 30 }, (_, index) => assistant(`a${turn}-${index}`))]).flat();
    const { id, ids } = await longChat(host, drafts);

    const client = await raw(host);
    client.send({ type: "subscribe", stream: `conversation:${id}`, window: { limit: 10 } });
    const view = await client.snapshot(`conversation:${id}`);
    expect(view.entries).toHaveLength(31);
    expect(view.entries[0]!.kind).toBe("pi.user");

    const result = await client.call("earlierEntries", { conversationId: id, before: view.before, limit: 10 });
    const page = result.value as Page;
    expect(page.entries).toHaveLength(31);
    expect(page.entries[0]!.kind).toBe("pi.user");
    expect(page.entries.at(-1)!.id).toBe(ids.at(-32));
    expect(page.before).toBe(ids.at(-63));
  });

  it("starts a resubscribe's window at `from`, past the limit", async () => {
    const host = await startFauxHost(defer);
    const { id, ids } = await longChat(host, Array.from({ length: 150 }, (_, index) => user(`m${index}`)));

    const client = await raw(host);
    client.send({ type: "subscribe", stream: `conversation:${id}`, window: { limit: 20, from: ids.at(-120) } });
    const view = await client.snapshot(`conversation:${id}`);
    expect(view.entries.map((entry) => entry.id)).toEqual(ids.slice(-120));
    expect(view.before).toBe(ids.at(-121));
  });

  it("answers earlierEntries only for a conversation this connection subscribes to", async () => {
    const host = await startFauxHost(defer);
    const { id, ids } = await longChat(host, [user("one"), user("two")]);

    const client = await raw(host);
    const result = await client.call("earlierEntries", { conversationId: id, before: ids.at(-1), limit: 10 });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Not subscribed");
  });

  it("refuses a page whose subscription was replaced while it loaded", async () => {
    const host = await startFauxHost(defer);
    const { id } = await longChat(host, Array.from({ length: 60 }, (_, index) => user(`m${index}`)));

    const client = await raw(host);
    const stream = `conversation:${id}`;
    client.send({ type: "subscribe", stream, images: "ref", window: { limit: 10 } });
    const view = await client.snapshot(stream);
    // The resubscribe lands while the page is still being read: the new
    // subscription would not answer the page's image refs.
    const loading = client.call("earlierEntries", { conversationId: id, before: view.before, limit: 10 });
    client.send({ type: "subscribe", stream, images: "ref", window: { limit: 10 } });
    const result = await loading;
    expect(result.ok).toBe(false);
    expect(result.error).toContain("resubscribed");
  });

  it("carries a page's images as refs the image call answers", async () => {
    const host = await startFauxHost(defer);
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const pictured: EntryDraft = {
      kind: "pi.user",
      model: [{ role: "user", content: [{ type: "text", text: "see" }, { type: "image", mimeType: "image/png", data: png }], timestamp: 0 }],
    };
    const { id } = await longChat(host, [pictured, ...Array.from({ length: 30 }, (_, index) => user(`m${index}`))]);

    const client = await raw(host);
    client.send({ type: "subscribe", stream: `conversation:${id}`, images: "ref", window: { limit: 10 } });
    const view = await client.snapshot(`conversation:${id}`);
    const result = await client.call("earlierEntries", { conversationId: id, before: view.before, limit: 100 });
    const page = result.value as Page;
    const block = page.entries
      .flatMap((entry) => (entry.model?.[0]?.content ?? []) as { type: string; ref?: string; data?: string }[])
      .find((candidate) => typeof candidate === "object" && candidate.type === "image");
    expect(block?.data).toBeUndefined();
    expect(block?.ref).toMatch(/^[0-9a-f]{64}$/);
    const image = await client.call("image", { ref: block!.ref });
    expect(image).toEqual({ ok: true, value: { data: png, mimeType: "image/png" } });
  });

  it("loads a long conversation back to its start through the client SDK", async () => {
    const host = await startFauxHost(defer);
    const { id, ids } = await longChat(host, Array.from({ length: 150 }, (_, index) => user(`m${index}`)));

    const reader = await connectTo(defer, host);
    await reader.controller.switchConversation(id);
    await waitForView(reader.view, (view) => view.conversation !== undefined);
    expect(reader.view.current().conversation!.entries.length).toBeLessThan(ids.length);
    while (reader.view.current().conversation!.before !== undefined) await reader.controller.loadEarlier(id);
    expect(reader.view.current().conversation!.entries.map((entry) => entry.id)).toEqual(ids);
  });
});
