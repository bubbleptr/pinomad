import { once } from "node:events";
import { mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { type ConversationId, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { CallMethods, ServerFrame } from "@pinomad/protocol/frames.ts";
import type { Home } from "@pinomad/protocol/organization.ts";
import { isBusy, transcript } from "@pinomad/protocol/transcript.ts";
import type { ConversationNode } from "@pinomad/protocol/organization.ts";
import { coding } from "../src/extensions/coding.ts";
import type { OpenedHost } from "../src/host.ts";
import { IndexDoc } from "../src/organization.ts";
import { connectTo, freePort, startConversation, startFauxHost, tempDir, useCleanups, waitForView } from "./support.ts";

const defer = useCleanups();
let nextCall = 1;

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

/** Every node in the organized view, top-level and nested. */
function allNodes(view: {
  organized: { chats: readonly ConversationNode[]; projects: readonly { conversations: readonly ConversationNode[] }[] };
}): ConversationNode[] {
  const flat = (nodes: readonly ConversationNode[]): ConversationNode[] =>
    nodes.flatMap((node) => [node, ...flat(node.children)]);
  return flat(view.organized.chats.concat(...view.organized.projects.flatMap((p) => p.conversations)));
}

describe("projects and conversations", () => {
  it("opens with no root conversation and shows none until one is created", async () => {
    const host = await startFauxHost(defer);
    expect(await host.harness.conversation(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT)).toBeUndefined();
    const client = await connectTo(defer, host);
    expect(client.view.current().conversation).toBeUndefined();
    expect(client.view.current().organized).toEqual({ chats: [], projects: [] });
  });

  it("normalizes, deduplicates, and validates project paths", async () => {
    const dir = await tempDir();
    defer(dir.remove);
    const host = await startFauxHost(defer);
    const client = await connectTo(defer, host);
    const normalized = await realpath(dir.path);

    await client.controller.addProject(join(dir.path, "sub", ".."));
    await waitForView(client.view, (view) => view.organized.projects.length === 1);
    const registered = client.view.current().organized.projects[0]!.project;
    expect(registered.path).toBe(normalized);
    expect(registered.name).toBe(dir.path.split("/").at(-1));

    // Same identity again: still one project.
    await client.controller.addProject(normalized);
    await waitForView(client.view, (view) => view.organized.projects.length === 1 && view.notices.length === 0);

    // A file and a missing path are refused with the path in the error.
    const file = join(dir.path, "a-file");
    await writeFile(file, "x");
    await client.controller.addProject(file);
    await client.controller.addProject(join(dir.path, "does-not-exist"));
    await waitForView(client.view, (view) => view.notices.length === 2);
    expect(client.view.current().notices.map((notice) => notice.message).join(" ")).toContain("a-file");
    expect(client.view.current().notices.map((notice) => notice.message).join(" ")).toContain("does-not-exist");
    expect(client.view.current().organized.projects).toHaveLength(1);
  });

  it("runs tools in the project dir for project conversations and in chats/<id> for chats", async () => {
    const project = await tempDir();
    defer(project.remove);
    const host = await startFauxHost(defer, {
      projects: [project.path],
      extensions: [coding],
      answers: [
        fauxAssistantMessage(fauxToolCall("bash", { command: "pwd" }), { stopReason: "toolUse" }),
        "project done",
        fauxAssistantMessage(fauxToolCall("bash", { command: "pwd" }), { stopReason: "toolUse" }),
        "chat done",
      ],
    });
    const client = await connectTo(defer, host);

    const projectConv = await startConversation(client, { kind: "project", path: project.path }, "where am I");
    await waitForView(client.view, (view) => !isBusy(view.conversation!) && transcript(view.conversation!).at(-1)?.text === "project done");
    const projectResults = client.view.current().conversation!.entries.filter((entry) => entry.kind === "pi.tool-result");
    expect(JSON.stringify(projectResults)).toContain(await realpath(project.path));

    const chatConv = await startConversation(client, { kind: "chat" }, "where am I");
    await waitForView(client.view, (view) => !isBusy(view.conversation!) && transcript(view.conversation!).at(-1)?.text === "chat done");
    const chatResults = client.view.current().conversation!.entries.filter((entry) => entry.kind === "pi.tool-result");
    expect(JSON.stringify(chatResults)).toContain(`chats/${chatConv}`);
    const dataDir = client.view.current().session.directory;
    await stat(join(dataDir, "chats", String(chatConv)));

    // Both exist in the index and the organized view.
    const nodes = allNodes(client.view.current());
    expect(nodes.map((node) => node.summary.id)).toEqual(expect.arrayContaining([projectConv, chatConv]));
    expect(client.view.current().organized.chats[0]!.summary.id).toBe(chatConv);
    expect(client.view.current().organized.projects[0]!.conversations[0]!.summary.id).toBe(projectConv);
  });

  it("deduplicates a retried createConversation by requestId", async () => {
    const host = await startFauxHost(defer);
    const client = await socketTo(host);
    const home: Home = { kind: "chat" };

    const first = await call(client, "createConversation", { home, text: "hi", requestId: "req-1" });
    const second = await call(client, "createConversation", { home, text: "hi", requestId: "req-1" });
    expect(first).toMatchObject({ ok: true });
    expect(second).toMatchObject({ ok: true });
    const firstId = (first as { value: { conversationId: ConversationId } }).value.conversationId;
    expect((second as { value: { conversationId: ConversationId } }).value.conversationId).toBe(firstId);

    const conversations = await host.harness.commit((tx) => tx.scanConversations({}, 256), BACKGROUND_CONTEXT);
    expect(conversations.items).toHaveLength(1);

    // The submission was admitted once too: one user message.
    const view = await host.harness.conversation(firstId, BACKGROUND_CONTEXT);
    const entries = await view!.entries({}, 256, undefined, BACKGROUND_CONTEXT);
    expect(entries.items.filter((entry) => entry.kind === "pi.user")).toHaveLength(1);
  });

  it("submits the first prompt on a retry after the creating commit landed alone", async () => {
    const host = await startFauxHost(defer, { answers: ["late answer"] });
    const raw = await socketTo(host);
    const home: Home = { kind: "chat" };

    // The first half landed — conversation + index entry with the requestId — but
    // the process died before submit, so the conversation holds no user entry.
    const partial = await host.harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: { model: { provider: "faux", modelId: "faux-1" } },
        init: async (tx, id) => {
          (await tx.doc(IndexDoc)).conversations.push({ id, home, createdAt: Date.now(), requestId: "req-crash" });
        },
      },
      BACKGROUND_CONTEXT,
    );

    const reply = await call(raw, "createConversation", { home, text: "recovered prompt", requestId: "req-crash" });
    expect(reply).toMatchObject({ ok: true });
    expect((reply as { value: { conversationId: ConversationId } }).value.conversationId).toBe(partial.id);

    const conversations = await host.harness.commit((tx) => tx.scanConversations({}, 256), BACKGROUND_CONTEXT);
    expect(conversations.items).toHaveLength(1);

    // The retried call admitted the prompt; the turn completes.
    const client = await connectTo(defer, host);
    await client.controller.switchConversation(partial.id);
    await waitForView(client.view, (v) => transcript(v.conversation!).at(-1)?.text === "late answer");
    const view = await host.harness.conversation(partial.id, BACKGROUND_CONTEXT);
    const entries = await view!.entries({}, 256, undefined, BACKGROUND_CONTEXT);
    expect(entries.items.filter((entry) => entry.kind === "pi.user")).toHaveLength(1);
  });

  it("hides an archived conversation from organize and restores it", async () => {
    const host = await startFauxHost(defer);
    const client = await connectTo(defer, host);
    const id = await startConversation(client, { kind: "chat" }, "hi");

    await client.controller.archive(id, true);
    await waitForView(client.view, (view) => view.organized.chats.length === 0);
    // The archiving client also stops showing it.
    expect(client.view.current().conversation).toBeUndefined();

    await client.controller.archive(id, false);
    await waitForView(client.view, (view) => view.organized.chats.some((node) => node.summary.id === id));
  });

  it("keeps projects and conversations across a host restart", async () => {
    const project = await tempDir();
    defer(project.remove);
    const port = await freePort();
    const first = await startFauxHost(defer, { port, dataDir: project.path, projects: [project.path] });
    const client = await connectTo(defer, first);
    const convId = await startConversation(client, { kind: "project", path: project.path }, "first prompt");
    const dataDir = client.view.current().session.directory;
    await first.close();
    await waitForView(client.view, (view) => view.connection === "reconnecting");

    await startFauxHost(defer, { port, dataDir, projects: [project.path] });
    await waitForView(client.view, (view) => view.connection === "connected");
    const view = client.view.current();
    // The startup `projects` option dedupes: still exactly one project.
    expect(view.organized.projects).toHaveLength(1);
    expect(view.organized.projects[0]!.conversations[0]!.summary.id).toBe(convId);
    // The shown conversation survives the restart.
    expect(view.conversation!.conversation.id).toBe(convId);
  });

  it("keeps a removed project's conversation in the index but drops it from organize", async () => {
    const project = await tempDir();
    defer(project.remove);
    const host = await startFauxHost(defer, { projects: [project.path] });
    const client = await connectTo(defer, host);
    const convId = await startConversation(client, { kind: "project", path: project.path }, "hi");

    await client.controller.removeProject(project.path);
    await waitForView(client.view, (view) => view.organized.projects.length === 0 && view.organized.chats.length === 0);
    const snapshot = await host.harness.snapshot(IndexDoc, BACKGROUND_CONTEXT);
    expect(snapshot!.conversations.some((entry) => entry.id === convId)).toBe(true);
  });
});
