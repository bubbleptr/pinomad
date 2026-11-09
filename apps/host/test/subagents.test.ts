// One kind of subagent (ADR-0046): background dispatch and reports, messages
// and Stop from the model and from the user, the working limit, archive, and
// a restart while a report is pending.
import { once } from "node:events";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import { type ConversationId, type ConversationView, type JsonObject, LiveDoc } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { transcript } from "@pinomad/protocol/transcript.ts";
import type { ModelSummary } from "@pinomad/protocol/view.ts";
import { question } from "../src/extensions/question.ts";
import { createSubagent } from "../src/extensions/subagent.ts";
import type { OpenedHost } from "../src/host.ts";
import { SubagentDoc } from "../src/subagent-doc.ts";
import { SubagentsDoc } from "../src/subagents.ts";
import { connectTo, freePort, startChat, startFauxHost, tempDir, useCleanups } from "./support.ts";

const defer = useCleanups();
const context = BACKGROUND_CONTEXT;

const extensions = (provided: { models: Models; modelSummaries: () => readonly ModelSummary[] }) => [
  question,
  createSubagent({ models: provided.models, modelSummaries: provided.modelSummaries, exclude: [question.extension] }),
];

const call = (name: string, args: JsonObject) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const answer = (text: string) => fauxAssistantMessage([fauxText(text)]);

function textOf(message: Message): string {
  const content = message.content;
  return typeof content === "string" ? content : content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

/**
 * One scripted model for the parent and its subagents: each request is
 * answered by its last message. `rules` map a substring of that message to a
 * reply; a tool result is acknowledged with its first line.
 */
function scripted(rules: readonly (readonly [string, () => ReturnType<typeof answer>])[]): FauxResponseStep[] {
  const route: FauxResponseStep = (request) => {
    const last = request.messages.findLast((message) => message.role !== "system")!;
    const text = textOf(last);
    if (last.role === "toolResult") return answer(`ack: ${text.split("\n")[0]}`);
    for (const [needle, reply] of rules) if (text.includes(needle)) return reply();
    return answer(`echo: ${text}`);
  };
  return Array.from({ length: 80 }, () => route);
}

type Result = { ok: boolean; value?: unknown; error?: string };

/** A bare socket for calls on a subagent conversation. */
async function rawClient(host: { url: string; token: string }) {
  const socket = new WebSocket(`${host.url}?token=${encodeURIComponent(host.token)}`);
  const pending = new Map<number, (value: Result) => void>();
  let next = 0;
  socket.on("message", (data) => {
    const frame = JSON.parse(String(data)) as { type: string; id: number; ok: boolean; value?: unknown; error?: string };
    if (frame.type !== "result") return;
    pending.get(frame.id)?.(frame.ok ? { ok: true, value: frame.value } : { ok: false, error: frame.error });
    pending.delete(frame.id);
  });
  await once(socket, "open");
  defer(() => socket.terminate());
  return {
    call: (method: string, args: unknown) =>
      new Promise<Result>((resolve) => {
        const id = ++next;
        pending.set(id, resolve);
        socket.send(JSON.stringify({ type: "call", id, method, args }));
      }),
  };
}

/** Resolve with the first view of `id` matching `predicate`. */
async function watchUntil(
  host: OpenedHost,
  id: ConversationId,
  predicate: (view: ConversationView) => boolean,
  timeoutMs = 20_000,
): Promise<ConversationView> {
  const conversation = (await host.harness.conversation(id, context))!;
  const watch = await conversation.watch(context);
  try {
    return await new Promise<ConversationView>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`conversation ${id} condition not met within ${timeoutMs} ms`)), timeoutMs);
      const check = (value: ConversationView): void => {
        if (!predicate(value)) return;
        clearTimeout(timer);
        resolve(value);
      };
      check(watch.value);
      watch.start(async (change) => {
        if (change.kind === "value") check(change.value);
      });
    });
  } finally {
    await watch.stop();
  }
}

/** Long enough that a child is still streaming it when a test acts (~15 s at the default rate). */
const ENDLESS = Array.from({ length: 3000 }, (_, i) => `word-${i}`).join(" ");

const texts = (view: ConversationView): string[] => transcript(view).map((each) => each.text);
const idle = (view: ConversationView): boolean => (view.docs["pi.live"] as { run?: unknown } | undefined)?.run === undefined;

async function registry(host: OpenedHost, root: ConversationId) {
  return (await host.harness.snapshot(SubagentsDoc, root, context))?.agents ?? {};
}

async function childNamed(host: OpenedHost, root: ConversationId, name: string): Promise<ConversationId> {
  await expect.poll(async () => (await registry(host, root))[name] !== undefined, { timeout: 15_000 }).toBe(true);
  return (await registry(host, root))[name]!.conversationId;
}

describe("background subagents", () => {
  it("returns at once and wakes the parent with the answer when it arrives", async () => {
    const host = await startFauxHost(defer, {
      extensions,
      answers: scripted([
        ["count files", () => answer("42 files")],
        ["[subagent counter answered]", () => answer("noted 42")],
        ["go", () => call("subagent", { task: "count files", name: "counter", background: true, checkout: "shared" })],
      ]),
    });
    const client = await connectTo(defer, host);
    const parent = await startChat(client, "go");

    const view = await watchUntil(host, parent, (value) => idle(value) && texts(value).includes("noted 42"));
    expect(texts(view).filter((text) => text.startsWith("[subagent counter answered]"))).toEqual(["[subagent counter answered]\n\n42 files"]);
    expect(texts(view)).toContain('ack: Started subagent "counter" in the background. Its answer will be reported to you when it arrives; message it with subagent_send.');
    const record = (await registry(host, parent)).counter!;
    expect(record).toMatchObject({ status: "idle", reporters: [], dispatcher: parent });
    expect(await host.harness.snapshot(SubagentDoc, record.conversationId, context)).toMatchObject({ name: "counter", lifecycle: "background" });
  });

  it("turns a foreground subagent background when the model messages it again", async () => {
    const host = await startFauxHost(defer, {
      extensions,
      answers: scripted([
        ["count files", () => answer("42 files")],
        ["and folders?", () => answer("3 folders")],
        ["[subagent counter answered]\n\n3 folders", () => answer("noted 3")],
        ["ask again", () => call("subagent_send", { name: "counter", message: "and folders?" })],
        ["go", () => call("subagent", { task: "count files", name: "counter", checkout: "shared" })],
      ]),
    });
    const client = await connectTo(defer, host);
    const parent = await startChat(client, "go");
    await watchUntil(host, parent, (value) => idle(value) && texts(value).at(-1) === "ack: [subagent counter answered]");
    const child = await childNamed(host, parent, "counter");
    expect((await host.harness.snapshot(SubagentDoc, child, context))?.lifecycle).toBe("foreground");

    await (await host.harness.conversation(parent, context))!.submit({ type: "input", content: "ask again" }, context);
    await watchUntil(host, parent, (value) => idle(value) && texts(value).includes("noted 3"));
    expect((await host.harness.snapshot(SubagentDoc, child, context))?.lifecycle).toBe("background");
    // Clients see the move: the summary's lifecycle and name.
    await expect
      .poll(() => client.view.current().organized.chats.flatMap((node) => node.children).find((node) => node.summary.id === child)?.summary)
      .toMatchObject({ lifecycle: "background", name: "counter" });
  });

  it("notes a user's direct messages without waking the parent, and subagent_read shows them", async () => {
    const host = await startFauxHost(defer, {
      extensions,
      answers: scripted([
        ["count files", () => answer("42 files")],
        ["how many md files?", () => answer("7 md files")],
        ["read it", () => call("subagent_read", { name: "counter" })],
        ["[subagent counter answered]", () => answer("noted")],
        ["go", () => call("subagent", { task: "count files", name: "counter", background: true, checkout: "shared" })],
      ]),
    });
    const client = await connectTo(defer, host);
    const raw = await rawClient(host);
    const parent = await startChat(client, "go");
    await watchUntil(host, parent, (value) => idle(value) && texts(value).includes("noted"));
    const child = await childNamed(host, parent, "counter");
    await expect.poll(async () => (await registry(host, parent)).counter?.status, { timeout: 15_000 }).toBe("idle");

    const sent = await raw.call("submit", { conversationId: child, text: "how many md files?", whenBusy: "followUp", requestId: "user-1" });
    expect(sent.ok).toBe(true);
    const noted = await watchUntil(host, parent, (value) => texts(value).some((text) => text.startsWith("[The user talked")));
    expect(texts(noted).at(-1)).toBe(
      "[The user talked with subagent counter directly: 1 message since you last read it. Call subagent_read to see them.]",
    );
    // A note wakes nobody.
    expect(idle(noted)).toBe(true);
    expect(await host.harness.snapshot(LiveDoc, parent, context)).not.toHaveProperty("run");

    await (await host.harness.conversation(parent, context))!.submit({ type: "input", content: "read it" }, context);
    const read = await watchUntil(host, parent, (value) => idle(value) && texts(value).some((text) => text.startsWith("ack: Delegated") || text.startsWith("ack: User")));
    const results = read.entries.filter((entry) => entry.kind === "pi.tool-result").map((entry) => textOf(entry.model![0] as Message));
    expect(results.at(-1)).toBe("Delegated: count files\n\ncounter: 42 files\n\nUser: how many md files?\n\ncounter: 7 md files");
  });

  it("notes a user's Stop but not the model's", async () => {
    const host = await startFauxHost(defer, {
      extensions,
      answers: scripted([
        ["write an essay", () => answer(ENDLESS)],
        ["stop it", () => call("subagent_stop", { name: "essay" })],
        ["again", () => call("subagent_send", { name: "essay", message: "write an essay again" })],
        ["go", () => call("subagent", { task: "write an essay", name: "essay", background: true, checkout: "shared" })],
      ]),
    });
    const client = await connectTo(defer, host);
    const raw = await rawClient(host);
    const parent = await startChat(client, "go");
    const child = await childNamed(host, parent, "essay");
    await watchUntil(host, child, (value) => !idle(value));

    expect((await raw.call("abort", { conversationId: child })).ok).toBe(true);
    await watchUntil(host, parent, (value) => texts(value).includes("[The user stopped subagent essay.]"));
    await expect.poll(async () => (await registry(host, parent)).essay?.status, { timeout: 15_000 }).toBe("stopped");

    const conversation = (await host.harness.conversation(parent, context))!;
    await conversation.waitForIdle(context);
    await (await conversation.submit({ type: "input", content: "again" }, context)).wait(context);
    await watchUntil(host, child, (value) => !idle(value));
    await (await conversation.submit({ type: "input", content: "stop it" }, context)).wait(context);
    await expect.poll(async () => (await registry(host, parent)).essay?.status, { timeout: 15_000 }).toBe("stopped");
    const view = await watchUntil(host, parent, idle);
    expect(texts(view).filter((text) => text.includes("stopped subagent"))).toEqual(["[The user stopped subagent essay.]"]);
  });

  it(`refuses a ninth working subagent`, async () => {
    const calls = Array.from({ length: 9 }, (_, i) =>
      fauxToolCall("subagent", { task: `slow job ${i}`, name: `job-${i}`, background: true, checkout: "shared" }),
    );
    const host = await startFauxHost(defer, {
      extensions,
      answers: scripted([
        ["slow job", () => answer(ENDLESS)],
        ["go", () => fauxAssistantMessage(calls, { stopReason: "toolUse" })],
      ]),
    });
    const client = await connectTo(defer, host);
    const parent = await startChat(client, "go");
    const view = await watchUntil(host, parent, (value) => value.entries.filter((entry) => entry.kind === "pi.tool-result").length === 9);
    const errors = view.entries
      .filter((entry) => entry.kind === "pi.tool-result" && (entry.model![0] as { isError?: boolean }).isError === true)
      .map((entry) => textOf(entry.model![0] as Message));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("At most 8 subagents can work at once");
    expect(Object.keys(await registry(host, parent))).toHaveLength(8);
    // Archive stops background subagents and their reporters.
    const raw = await rawClient(host);
    expect((await raw.call("archive", { conversationId: parent, archived: true })).ok).toBe(true);
    for (const record of Object.values(await registry(host, parent))) {
      expect(record.status).toBe("stopped");
      expect((await host.harness.snapshot(LiveDoc, record.conversationId, context))?.run).toBeUndefined();
    }
  });

  it("reports an answer exactly once across a restart", async () => {
    const dir = await tempDir();
    defer(dir.remove);
    const port = await freePort();
    const rules = (childAnswer: () => ReturnType<typeof answer>) =>
      scripted([
        ["count files", childAnswer],
        ["[subagent counter answered]", () => answer("noted")],
        ["go", () => call("subagent", { task: "count files", name: "counter", background: true, checkout: "shared" })],
      ]);
    const first = await startFauxHost(defer, { dataDir: dir.path, port, extensions, answers: rules(() => answer(ENDLESS)) });
    const client = await connectTo(defer, first);
    const parent = await startChat(client, "go");
    const child = await childNamed(first, parent, "counter");
    await watchUntil(first, child, (value) => !idle(value));
    await first.close();

    const second = await startFauxHost(defer, { dataDir: dir.path, port, extensions, answers: rules(() => answer("42 files")) });
    const view = await watchUntil(second, parent, (value) => idle(value) && texts(value).includes("noted"), 30_000);
    expect(texts(view).filter((text) => text.startsWith("[subagent counter answered]"))).toHaveLength(1);
    await expect.poll(async () => (await registry(second, parent)).counter?.status, { timeout: 15_000 }).toBe("idle");
  });
});
