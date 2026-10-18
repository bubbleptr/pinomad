// Top-level conversations with a named agent (issue #137, ADR-0023 §7/§8):
// `createConversation.agent` resolution — role lookup before any write, the
// model chain (arg > role pin > host default), prompt copy, `IndexEntry.role`
// as the one durable source, and the summary projection for top-level
// conversations and their forks.
import { once } from "node:events";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AgentDoc, type ConversationId } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { CallMethods, ServerFrame } from "@pinomad/protocol/frames.ts";
import type { ConversationNode } from "@pinomad/protocol/organization.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import type { ConversationSummary, DurableView, ModelSummary } from "@pinomad/protocol/view.ts";
import { createConversation, IndexDoc } from "../src/organization.ts";
import type { OpenedHost } from "../src/host.ts";
import { connectTo, startFauxHost, startChat, tempDir, useCleanups, waitForView } from "./support.ts";

const defer = useCleanups();
const context = BACKGROUND_CONTEXT;
let nextCall = 1;

/** A raw socket that can observe call results — the controller's create is command-class and hides them. */
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

const REVIEWER = `---\ndescription: "Reviews code"\nmodel: "faux/faux-1"\nthinkingLevel: "high"\n---\n\nLook for mistakes.\n`;
const PLAIN = `---\ndescription: "Just a helper"\n---\n\nBe helpful.\n`;

/** A host whose agents dir is seeded before open. */
async function hostWithRoles(files: Record<string, string>, options: Parameters<typeof startFauxHost>[1] = {}) {
  const dir = await tempDir();
  defer(dir.remove);
  await mkdir(join(dir.path, "agents"), { recursive: true });
  for (const [file, text] of Object.entries(files)) await writeFile(join(dir.path, "agents", file), text);
  const host = await startFauxHost(defer, { ...options, dataDir: dir.path });
  return { host, dir };
}

/** The organized summary for `id`, wherever it nests. */
async function summaryOf(client: RemoteDurable, target: ConversationId): Promise<ConversationSummary | undefined> {
  const find = (view: DurableView): ConversationSummary | undefined => {
    const walk = (node: ConversationNode): ConversationSummary | undefined =>
      node.summary.id === target ? node.summary : node.children.map(walk).find((found) => found !== undefined);
    return [...view.organized.chats, ...view.organized.projects.flatMap((entry) => entry.conversations)]
      .map(walk)
      .find((found) => found !== undefined);
  };
  await waitForView(client.view, (view) => find(view) !== undefined);
  return find(client.view.current());
}

const createdId = (result: Extract<ServerFrame, { type: "result" }>): ConversationId =>
  Number((result as { value: { conversationId: number } }).value.conversationId) as ConversationId;

describe("top-level conversations with a named agent", () => {
  it("copies the role's prompt and pins into the new conversation; the index carries the role", async () => {
    // faux-1 needs `reasoning` or the "high" pin clamps to "off".
    const { host } = await hostWithRoles({ "reviewer.md": REVIEWER }, {
      fauxModels: [{ id: "faux-1", name: "Faux One", reasoning: true }],
    });
    const client = await connectTo(defer, host);

    await client.controller.createConversation({ kind: "chat" }, "look at this diff", { agent: "reviewer" });
    const id = client.view.current().conversation!.conversation.id;

    const agent = (await host.harness.snapshot(AgentDoc, id, context))!;
    expect(agent.instructions).toBe("Look for mistakes.");
    expect(agent.model).toEqual({ provider: "faux", modelId: "faux-1" });
    expect(agent.thinkingLevel).toBe("high");

    const index = (await host.harness.snapshot(IndexDoc, context))!;
    expect(index.conversations.find((entry) => entry.id === id)?.role).toBe("reviewer");
  });

  it("resolves model and thinking level as args > role > host default", async () => {
    const { host } = await hostWithRoles(
      {
        "pinned.md": `---\ndescription: "Pinned"\nmodel: "faux/faux-2"\nthinkingLevel: "low"\n---\n\nPinned prompt.\n`,
        "bare.md": PLAIN,
      },
      // The list replaces the default model — faux-1 must stay listed.
      { fauxModels: [{ id: "faux-1", name: "Faux One", reasoning: true }, { id: "faux-2", name: "Faux Two", reasoning: true }] },
    );
    const raw = await socketTo(host);

    // The role's pins win over the host default.
    let result = await call(raw, "createConversation", {
      home: { kind: "chat" },
      text: "pinned",
      requestId: "pin-1",
      agent: "pinned",
    });
    expect(result).toMatchObject({ ok: true });
    let agent = (await host.harness.snapshot(AgentDoc, createdId(result), context))!;
    expect(agent.model).toEqual({ provider: "faux", modelId: "faux-2" });
    expect(agent.thinkingLevel).toBe("low");

    // Explicit args win over the role's pins.
    result = await call(raw, "createConversation", {
      home: { kind: "chat" },
      text: "override",
      requestId: "pin-2",
      agent: "pinned",
      model: { provider: "faux", modelId: "faux-1" },
      thinkingLevel: "high",
    });
    expect(result).toMatchObject({ ok: true });
    agent = (await host.harness.snapshot(AgentDoc, createdId(result), context))!;
    expect(agent.model).toEqual({ provider: "faux", modelId: "faux-1" });
    expect(agent.thinkingLevel).toBe("high");

    // No pins anywhere → the host default stands.
    result = await call(raw, "createConversation", {
      home: { kind: "chat" },
      text: "bare",
      requestId: "pin-3",
      agent: "bare",
    });
    expect(result).toMatchObject({ ok: true });
    agent = (await host.harness.snapshot(AgentDoc, createdId(result), context))!;
    expect(agent.model).toEqual({ provider: "faux", modelId: "faux-1" });
    expect(agent.instructions).toBe("Be helpful.");
  });

  it("rejects an unknown or problem agent before anything is written", async () => {
    const { host } = await hostWithRoles({
      "reviewer.md": REVIEWER,
      // A file that fails to load lands in `problems`, not `roles`.
      "broken.md": `---\nmodel: "faux/faux-1"\n---\n\nNo description.\n`,
    });
    const client = await connectTo(defer, host);
    const raw = await socketTo(host);

    const missing = await call(raw, "createConversation", {
      home: { kind: "chat" },
      text: "hi",
      requestId: "bad-1",
      agent: "ghost",
    });
    expect(missing).toMatchObject({ ok: false, error: expect.stringContaining('Unknown agent "ghost"') });
    expect(missing).toMatchObject({ ok: false, error: expect.stringContaining("reviewer") });

    const broken = await call(raw, "createConversation", {
      home: { kind: "chat" },
      text: "hi",
      requestId: "bad-2",
      agent: "broken",
    });
    expect(broken).toMatchObject({ ok: false, error: expect.stringContaining('"broken"') });
    expect((broken as { error: string }).error).toMatch(/description/i);

    // Nothing was written: no conversation, no index entry.
    expect((await host.harness.snapshot(IndexDoc, context))!.conversations).toEqual([]);
    await waitForView(client.view, (view) => view.organized.chats.length === 0);
  });

  it("rejects when the effective model is not advertised — from args, the role pin, and the host default", async () => {
    const { host, dir } = await hostWithRoles({
      "bare.md": PLAIN,
      "missing.md": `---\ndescription: "Gone"\nmodel: "faux/gone"\n---\n\nPinned elsewhere.\n`,
    });
    const raw = await socketTo(host);

    // The arg wins and is unresolvable — rejected like a create without an agent.
    const viaArg = await call(raw, "createConversation", {
      home: { kind: "chat" },
      text: "hi",
      requestId: "m-1",
      agent: "bare",
      model: { provider: "faux", modelId: "gone" },
    });
    expect(viaArg).toMatchObject({ ok: false, error: "Unknown model: faux/gone" });

    // The role pins a model the host does not advertise.
    const viaRole = await call(raw, "createConversation", {
      home: { kind: "chat" },
      text: "hi",
      requestId: "m-2",
      agent: "missing",
    });
    expect(viaRole).toMatchObject({ ok: false, error: expect.stringContaining("faux/gone") });

    // The host default is stale — with an agent even the inherited model is
    // checked. (The wire path never produces this: `updateSettings` and the
    // settings file both validate `defaultModel`, so a stale default only
    // reaches the call from the settings fallback — drive it directly.)
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const summaries: ModelSummary[] = [
      { provider: "faux", modelId: "faux-1", name: "Faux One", contextWindow: 8000, thinkingLevels: ["off"] },
    ];
    const roles = { roles: [{ name: "bare", description: "Just a helper", prompt: "Be helpful." }], problems: [] };
    await expect(
      createConversation(
        host.harness,
        dir.path,
        { home: { kind: "chat" }, text: "hi", requestId: "m-3", agent: "bare" },
        { model: { provider: "gone", modelId: "x" } },
        models,
        () => summaries,
        roles,
        context,
      ),
    ).rejects.toThrow("gone/x");
    // The same stale default without an agent is not this check's business.
    const plain = await createConversation(
      host.harness,
      dir.path,
      { home: { kind: "chat" }, text: "hi", requestId: "m-4" },
      { model: { provider: "gone", modelId: "x" } },
      models,
      () => summaries,
      roles,
      context,
    );
    expect(typeof plain).toBe("number");

    expect(
      (await host.harness.snapshot(IndexDoc, context))!.conversations.every((entry) => entry.role === undefined),
    ).toBe(true);
  });

  it("leaves a no-agent create unchanged: host default, no role, no instructions", async () => {
    const { host } = await hostWithRoles({ "reviewer.md": REVIEWER });
    const client = await connectTo(defer, host);

    const id = await startChat(client, "plain");
    const agent = (await host.harness.snapshot(AgentDoc, id, context))!;
    expect(agent.model).toEqual({ provider: "faux", modelId: "faux-1" });
    expect(agent.instructions).toBeUndefined();
    const index = (await host.harness.snapshot(IndexDoc, context))!;
    expect(index.conversations.find((entry) => entry.id === id)!.role).toBeUndefined();
    expect((await summaryOf(client, id))?.role).toBeUndefined();
  });

  it("keeps the copied prompt after the role file is edited or deleted; a retried requestId still dedupes", async () => {
    const { host, dir } = await hostWithRoles({ "reviewer.md": REVIEWER });
    const client = await connectTo(defer, host);
    const raw = await socketTo(host);

    const created = await call(raw, "createConversation", {
      home: { kind: "chat" },
      text: "first",
      requestId: "stable-1",
      agent: "reviewer",
    });
    expect(created).toMatchObject({ ok: true });
    const id = createdId(created);

    // Edit, then delete: the snapshot at create time is what the conversation keeps.
    await writeFile(join(dir.path, "agents", "reviewer.md"), `---\ndescription: "Edited"\n---\n\nDifferent prompt.\n`);
    await waitForView(client.view, (view) => view.agents?.roles[0]?.prompt === "Different prompt.");
    let agent = (await host.harness.snapshot(AgentDoc, id, context))!;
    expect(agent.instructions).toBe("Look for mistakes.");

    await rm(join(dir.path, "agents", "reviewer.md"));
    await waitForView(client.view, (view) => view.agents?.roles.length === 0);

    // The retry never re-resolves the agent — the index entry wins.
    const retried = await call(raw, "createConversation", {
      home: { kind: "chat" },
      text: "first",
      requestId: "stable-1",
      agent: "reviewer",
    });
    expect(retried).toMatchObject({ ok: true, value: { conversationId: id } });
    expect((await host.harness.snapshot(IndexDoc, context))!.conversations).toHaveLength(1);
    agent = (await host.harness.snapshot(AgentDoc, id, context))!;
    expect(agent.instructions).toBe("Look for mistakes.");
    // The resubmitted first message deduped on requestId — one user entry.
    const conversation = (await host.harness.conversation(id, context))!;
    const watch = await conversation.watch(context);
    try {
      expect(watch.value.entries.filter((entry) => entry.kind === "pi.user")).toHaveLength(1);
    } finally {
      await watch.stop();
    }
  });

  it("projects the role onto top-level and fork summaries, at publish time and after a restart", async () => {
    const { host, dir } = await hostWithRoles({ "reviewer.md": REVIEWER });
    const client = await connectTo(defer, host);
    const raw = await socketTo(host);

    const created = await call(raw, "createConversation", {
      home: { kind: "chat" },
      text: "hello",
      requestId: "fam-1",
      agent: "reviewer",
    });
    expect(created).toMatchObject({ ok: true });
    const id = createdId(created);
    // Incremental path: the summary carries the role as soon as the create lands.
    expect((await summaryOf(client, id))?.role).toBe("reviewer");

    // A fork shows the name it inherited — its summary has no durable role field of its own.
    const conversation = (await host.harness.conversation(id, context))!;
    const entryId = String((await conversation.entries({}, 1, undefined, context)).items[0]!.id);
    const forked = await call(raw, "fork", { conversationId: id, entryId });
    expect(forked).toMatchObject({ ok: true });
    const forkId = createdId(forked);
    expect((await summaryOf(client, forkId))?.role).toBe("reviewer");

    // Startup path: a fresh host over the same store projects the same names.
    await host.close();
    const reopened = await startFauxHost(defer, { dataDir: dir.path });
    const again = await connectTo(defer, reopened);
    expect((await summaryOf(again, id))?.role).toBe("reviewer");
    expect((await summaryOf(again, forkId))?.role).toBe("reviewer");
  });
});
