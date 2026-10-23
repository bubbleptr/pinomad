// Switching a conversation's named agent mid-conversation (issue #314,
// ADR-0023): the current role document, the switch semantics, live summary
// projection, fork inheritance, and the read-inside-the-commit settings path.
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AgentDoc, configure, type ConversationId, type JsonObject } from "@earendil-works/pi-durable";
import type { Models } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { CallMethods, ServerFrame } from "@pinomad/protocol/frames.ts";
import type { ConversationNode } from "@pinomad/protocol/organization.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import { isBusy, transcript } from "@pinomad/protocol/transcript.ts";
import type { ConversationSummary, DurableView, ModelSummary } from "@pinomad/protocol/view.ts";
import type { AgentRoleStore } from "../src/agent-roles.ts";
import { createSubagent } from "../src/extensions/subagent.ts";
import type { OpenedHost } from "../src/host.ts";
import { RoleDoc } from "../src/role-doc.ts";
import { connectTo, LONG_ANSWER, startChat, startFauxHost, tempDir, useCleanups, waitForView } from "./support.ts";

const defer = useCleanups();
const context = BACKGROUND_CONTEXT;
let nextCall = 1;

const REVIEWER = `---
description: "Reviews code"
model: "faux/faux-thinker"
thinkingLevel: "high"
---

Be strict.
`;
const PLANNER = `---
description: "Plans work"
model: "faux/faux-1"
---

Plan it.
`;
const BARE = `---
description: "Just a helper"
---

Be helpful.
`;
const SILENT = `---
description: "No prompt"
---
`;
const MISSING = `---
description: "Gone"
model: "faux/gone"
---

Pinned elsewhere.
`;
const BROKEN = `---
model: "faux/faux-1"
---

No description.
`;

const MODELS = [
  { id: "faux-1", name: "Faux One" },
  { id: "faux-thinker", name: "Faux Thinker", reasoning: true },
];

/** A host whose agents dir is seeded before open. */
async function hostWithRoles(files: Record<string, string>, options: Parameters<typeof startFauxHost>[1] = {}) {
  const dir = await tempDir();
  defer(dir.remove);
  await mkdir(join(dir.path, "agents"), { recursive: true });
  for (const [file, text] of Object.entries(files)) await writeFile(join(dir.path, "agents", file), text);
  const host = await startFauxHost(defer, { fauxModels: MODELS, ...options, dataDir: dir.path });
  return { host, dir };
}

/** A raw socket that can observe call results — the controller hides command-class failures in notices. */
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

async function waitIdle(client: RemoteDurable, text: string): Promise<void> {
  await waitForView(
    client.view,
    (view) => !isBusy(view.conversation!) && transcript(view.conversation!).at(-1)?.text === text,
  );
}

async function newestEntryId(host: OpenedHost, id: ConversationId): Promise<string> {
  const conversation = (await host.harness.conversation(id, context))!;
  const page = await conversation.entries({}, 1, undefined, context);
  return String(page.items[0]!.id);
}

async function agentOf(host: OpenedHost, id: ConversationId) {
  return (await host.harness.snapshot(AgentDoc, id, context)) ?? {};
}

async function roleOf(host: OpenedHost, id: ConversationId) {
  return await host.harness.snapshot(RoleDoc, id, context);
}

/** The subagent extension, configured like the host's composition root. */
const subagents = (provided: {
  models: Models;
  modelSummaries: () => readonly ModelSummary[];
  agentRoles: AgentRoleStore;
}) => [
  createSubagent({
    models: provided.models,
    modelSummaries: provided.modelSummaries,
    roles: () => provided.agentRoles.value.roles,
    exclude: [],
  }),
];

const delegates = (args: JsonObject) =>
  fauxAssistantMessage(fauxToolCall("subagent", args), { stopReason: "toolUse" });

describe("setAgent", () => {
  it("applies the role's prompt, model and clamped thinking level", async () => {
    const { host } = await hostWithRoles({ "reviewer.md": REVIEWER, "planner.md": PLANNER, "bare.md": BARE, "silent.md": SILENT });
    const client = await connectTo(defer, host);
    const raw = await socketTo(host);
    const id = await startChat(client, "hello");
    await waitIdle(client, LONG_ANSWER);

    // A new conversation records "no agent" explicitly, so currentAgent is null.
    expect((await summaryOf(client, id))?.currentAgent).toBeNull();

    expect(await call(raw, "setAgent", { conversationId: id, agent: "reviewer" })).toMatchObject({ ok: true });
    expect(await agentOf(host, id)).toMatchObject({
      instructions: "Be strict.",
      model: { provider: "faux", modelId: "faux-thinker" },
      thinkingLevel: "high",
    });
    expect((await roleOf(host, id))?.name).toBe("reviewer");
    await waitForView(client.view, (view) => summaryOfNow(view, id)?.currentAgent === "reviewer");

    // A role without a model keeps the current one; its missing level keeps the
    // current one too (clamped against the model that actually runs).
    expect(await call(raw, "setAgent", { conversationId: id, agent: "bare" })).toMatchObject({ ok: true });
    expect(await agentOf(host, id)).toMatchObject({
      instructions: "Be helpful.",
      model: { provider: "faux", modelId: "faux-thinker" },
      thinkingLevel: "high",
    });

    // An empty prompt clears instructions without touching the model.
    expect(await call(raw, "setAgent", { conversationId: id, agent: "silent" })).toMatchObject({ ok: true });
    expect((await agentOf(host, id)).instructions).toBeUndefined();
    expect(await agentOf(host, id)).toMatchObject({ model: { provider: "faux", modelId: "faux-thinker" } });

    // A role pin reaches a model with fewer levels: high clamps to off on faux-1.
    expect(await call(raw, "setAgent", { conversationId: id, agent: "planner" })).toMatchObject({ ok: true });
    expect(await agentOf(host, id)).toMatchObject({
      model: { provider: "faux", modelId: "faux-1" },
      thinkingLevel: "off",
    });
    expect((await roleOf(host, id))?.name).toBe("planner");
    await waitForView(client.view, (view) => summaryOfNow(view, id)?.currentAgent === "planner");
  });

  it("clears only the instructions for null and keeps the model and creation role", async () => {
    const { host } = await hostWithRoles({ "reviewer.md": REVIEWER });
    const client = await connectTo(defer, host);
    const raw = await socketTo(host);

    await client.controller.createConversation({ kind: "chat" }, "hello", { agent: "reviewer" });
    const id = client.view.current().conversation!.conversation.id;
    await waitIdle(client, LONG_ANSWER);
    const before = await agentOf(host, id);
    expect(before).toMatchObject({
      instructions: "Be strict.",
      model: { provider: "faux", modelId: "faux-thinker" },
      thinkingLevel: "high",
    });

    expect(await call(raw, "setAgent", { conversationId: id, agent: null })).toMatchObject({ ok: true });
    const after = await agentOf(host, id);
    expect(after.instructions).toBeUndefined();
    expect(after.model).toEqual(before.model);
    expect(after.thinkingLevel).toBe(before.thinkingLevel);
    expect(await roleOf(host, id)).toEqual({ name: null });
    // role stays the creation name; currentAgent becomes "no agent".
    await waitForView(
      client.view,
      (view) => summaryOfNow(view, id)?.role === "reviewer" && summaryOfNow(view, id)?.currentAgent === null,
    );
  });

  it("rejects an unavailable model, an unknown name, a broken file and a missing model without writing", async () => {
    const { host } = await hostWithRoles({
      "reviewer.md": REVIEWER,
      "bare.md": BARE,
      "missing.md": MISSING,
      "broken.md": BROKEN,
    });
    const client = await connectTo(defer, host);
    const raw = await socketTo(host);
    const id = await startChat(client, "hello");
    await waitIdle(client, LONG_ANSWER);
    const before = await agentOf(host, id);
    const beforeRole = await roleOf(host, id);

    for (const [agent, message] of [
      ["missing", "faux/gone"],
      ["ghost", 'Unknown agent "ghost"'],
      ["broken", "description"],
    ] as const) {
      const result = await call(raw, "setAgent", { conversationId: id, agent });
      expect(result).toMatchObject({ ok: false, error: expect.stringContaining(message) });
    }
    expect(await agentOf(host, id)).toEqual(before);
    expect(await roleOf(host, id)).toEqual(beforeRole);

    // No model at all is refused too — a switch must leave a runnable agent.
    await host.harness.commit((tx) => configure(tx, id, { model: null, thinkingLevel: null }), context);
    const noModel = await call(raw, "setAgent", { conversationId: id, agent: "bare" });
    expect(noModel).toMatchObject({ ok: false, error: expect.stringContaining('Agent "bare" has no model') });
    expect((await agentOf(host, id)).model).toBeUndefined();
    expect((await roleOf(host, id))?.name).toBeNull();
  });

  it("re-applies the current file when the same role is selected again", async () => {
    const { host, dir } = await hostWithRoles({ "reviewer.md": REVIEWER });
    const client = await connectTo(defer, host);
    const raw = await socketTo(host);

    await client.controller.createConversation({ kind: "chat" }, "hello", { agent: "reviewer" });
    const id = client.view.current().conversation!.conversation.id;
    await waitIdle(client, LONG_ANSWER);
    expect((await agentOf(host, id)).thinkingLevel).toBe("high");

    await writeFile(
      join(dir.path, "agents", "reviewer.md"),
      `---
description: "Edited"
model: "faux/faux-thinker"
thinkingLevel: "medium"
---

Updated prompt.
`,
    );
    await waitForView(client.view, (view) => view.agents?.roles[0]?.prompt === "Updated prompt.");

    expect(await call(raw, "setAgent", { conversationId: id, agent: "reviewer" })).toMatchObject({ ok: true });
    expect(await agentOf(host, id)).toMatchObject({
      instructions: "Updated prompt.",
      model: { provider: "faux", modelId: "faux-thinker" },
      thinkingLevel: "medium",
    });
    expect((await roleOf(host, id))?.name).toBe("reviewer");
  });

  it("rejects switching a subagent", async () => {
    let release!: (message: ReturnType<typeof fauxAssistantMessage>) => void;
    const childGate = new Promise<ReturnType<typeof fauxAssistantMessage>>((resolve) => (release = resolve));
    const { host } = await hostWithRoles(
      { "reviewer.md": REVIEWER },
      { extensions: subagents, answers: [delegates({ task: "go", role: "reviewer" }), () => childGate, "parent final"] },
    );
    const client = await connectTo(defer, host);
    const raw = await socketTo(host);
    await startChat(client, "delegate");
    await waitForView(client.view, (view) =>
      view.organized.chats.some((node) => node.children.some((child) => child.summary.currentAgent === "reviewer")),
    );
    const childSummary = client.view.current().organized.chats.flatMap((node) => node.children)[0]!.summary;
    const child = childSummary.id;
    // A subagent cannot switch: its current agent is the role the call gave.
    expect(childSummary).toMatchObject({ role: "reviewer", currentAgent: "reviewer" });
    const before = await agentOf(host, child);

    const result = await call(raw, "setAgent", { conversationId: child, agent: "reviewer" });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("Subagent") });
    expect(await agentOf(host, child)).toEqual(before);
    expect(await roleOf(host, child)).toBeUndefined();

    release(fauxAssistantMessage("child answer"));
    await waitIdle(client, "parent final");
  });
});

/** Hold the next snapshot(AgentDoc, id) until released — the old read-before-commit window. */
function gateNextAgentRead(host: OpenedHost, id: ConversationId): { release(): void; restore(): void } {
  const original = host.harness.snapshot;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let gated = false;
  host.harness.snapshot = (async (...args: [unknown, unknown, unknown]) => {
    if (!gated && args[0] === AgentDoc && args[1] === id) {
      gated = true;
      await gate;
    }
    return Reflect.apply(original, host.harness, args);
  }) as typeof host.harness.snapshot;
  return { release, restore: () => void (host.harness.snapshot = original) };
}

describe("concurrent settings", () => {
  it("does not lose a concurrent model switch when selecting an agent", async () => {
    const { host } = await hostWithRoles({ "reviewer.md": REVIEWER, "bare.md": BARE });
    const client = await connectTo(defer, host);
    const raw = await socketTo(host);
    await client.controller.createConversation({ kind: "chat" }, "hello", { agent: "reviewer" });
    const id = client.view.current().conversation!.conversation.id;
    await waitIdle(client, LONG_ANSWER);

    const gate = gateNextAgentRead(host, id);
    try {
      // The switch starts first; the model change must not be overwritten by
      // a config snapshot the switch read before that model change committed.
      const switched = call(raw, "setAgent", { conversationId: id, agent: "bare" });
      const modeled = await call(raw, "setModel", {
        conversationId: id,
        model: { provider: "faux", modelId: "faux-1" },
      });
      expect(modeled).toMatchObject({ ok: true });
      gate.release();
      expect(await switched).toMatchObject({ ok: true });
    } finally {
      gate.release();
      gate.restore();
    }

    expect(await agentOf(host, id)).toMatchObject({
      instructions: "Be helpful.",
      model: { provider: "faux", modelId: "faux-1" },
      thinkingLevel: "off",
    });
    expect((await roleOf(host, id))?.name).toBe("bare");
  });

  it("does not lose a concurrent thinking-level change when setting the model", async () => {
    const { host } = await hostWithRoles({ "reviewer.md": REVIEWER });
    const client = await connectTo(defer, host);
    const raw = await socketTo(host);
    await client.controller.createConversation({ kind: "chat" }, "hello", { agent: "reviewer" });
    const id = client.view.current().conversation!.conversation.id;
    await waitIdle(client, LONG_ANSWER);

    const gate = gateNextAgentRead(host, id);
    try {
      const modeled = call(raw, "setModel", {
        conversationId: id,
        model: { provider: "faux", modelId: "faux-thinker" },
      });
      const leveled = await call(raw, "setThinkingLevel", { conversationId: id, level: "medium" });
      expect(leveled).toMatchObject({ ok: true });
      gate.release();
      expect(await modeled).toMatchObject({ ok: true });
    } finally {
      gate.release();
      gate.restore();
    }

    expect(await agentOf(host, id)).toMatchObject({
      model: { provider: "faux", modelId: "faux-thinker" },
      thinkingLevel: "medium",
    });
  });

});

describe("currentAgent projection", () => {
  it("keeps role at creation, follows switches, and survives a restart", async () => {
    const { host, dir } = await hostWithRoles({ "reviewer.md": REVIEWER, "planner.md": PLANNER });
    const client = await connectTo(defer, host);
    const raw = await socketTo(host);

    await client.controller.createConversation({ kind: "chat" }, "hello", { agent: "reviewer" });
    const id = client.view.current().conversation!.conversation.id;
    await waitIdle(client, LONG_ANSWER);
    await waitForView(
      client.view,
      (view) => summaryOfNow(view, id)?.role === "reviewer" && summaryOfNow(view, id)?.currentAgent === "reviewer",
    );

    expect(await call(raw, "setAgent", { conversationId: id, agent: "planner" })).toMatchObject({ ok: true });
    await waitForView(
      client.view,
      (view) => summaryOfNow(view, id)?.role === "reviewer" && summaryOfNow(view, id)?.currentAgent === "planner",
    );

    await host.close();
    const reopened = await startFauxHost(defer, { dataDir: dir.path, fauxModels: MODELS });
    const again = await connectTo(defer, reopened);
    await waitForView(
      again.view,
      (view) => summaryOfNow(view, id)?.role === "reviewer" && summaryOfNow(view, id)?.currentAgent === "planner",
    );
  });

  it("materializes the switched name into forks, including an explicit null", async () => {
    const { host } = await hostWithRoles(
      { "reviewer.md": REVIEWER, "planner.md": PLANNER },
      { answers: [LONG_ANSWER, LONG_ANSWER, LONG_ANSWER] },
    );
    const client = await connectTo(defer, host);
    const raw = await socketTo(host);

    await client.controller.createConversation({ kind: "chat" }, "first", { agent: "reviewer" });
    const id = client.view.current().conversation!.conversation.id;
    await waitIdle(client, LONG_ANSWER);

    expect(await call(raw, "setAgent", { conversationId: id, agent: "planner" })).toMatchObject({ ok: true });
    await client.controller.submit("after switch", "followUp");
    await waitIdle(client, LONG_ANSWER);
    const switchedEntry = await newestEntryId(host, id);
    const forked = await call(raw, "fork", { conversationId: id, entryId: switchedEntry });
    expect(forked).toMatchObject({ ok: true });
    const forkId = Number((forked as { value: { conversationId: number } }).value.conversationId) as ConversationId;
    // No restart in between: the fork's copied RoleDoc is materialized and valued.
    expect(await summaryOf(client, forkId)).toMatchObject({ role: "reviewer", currentAgent: "planner" });
    expect(await agentOf(host, forkId)).toMatchObject({ instructions: "Plan it." });

    expect(await call(raw, "setAgent", { conversationId: id, agent: null })).toMatchObject({ ok: true });
    await client.controller.submit("after null", "followUp");
    await waitIdle(client, LONG_ANSWER);
    const nullEntry = await newestEntryId(host, id);
    const nullFork = await call(raw, "fork", { conversationId: id, entryId: nullEntry });
    expect(nullFork).toMatchObject({ ok: true });
    const nullForkId = Number((nullFork as { value: { conversationId: number } }).value.conversationId) as ConversationId;
    expect(await summaryOf(client, nullForkId)).toMatchObject({ role: "reviewer", currentAgent: null });
    expect((await agentOf(host, nullForkId)).instructions).toBeUndefined();
  });

  it("falls back to the root role for a fork of a conversation without a role document", async () => {
    const { host } = await hostWithRoles(
      { "reviewer.md": REVIEWER },
      { answers: [LONG_ANSWER, LONG_ANSWER] },
    );
    const client = await connectTo(defer, host);
    const raw = await socketTo(host);

    await client.controller.createConversation({ kind: "chat" }, "first", { agent: "reviewer" });
    const id = client.view.current().conversation!.conversation.id;
    await waitIdle(client, LONG_ANSWER);

    // Simulate a conversation created before RoleDoc existed.
    await host.harness.commit((tx) => tx.retireDoc(RoleDoc, id), context);
    await waitForView(client.view, (view) => summaryOfNow(view, id)?.currentAgent === "reviewer");
    await client.controller.submit("after retirement", "followUp");
    await waitIdle(client, LONG_ANSWER);

    const forked = await call(raw, "fork", { conversationId: id, entryId: await newestEntryId(host, id) });
    expect(forked).toMatchObject({ ok: true });
    const forkId = Number((forked as { value: { conversationId: number } }).value.conversationId) as ConversationId;
    expect((await summaryOf(client, forkId))?.currentAgent).toBe("reviewer");
  });

  it("shows the config at the fork entry, not the agent that produced the answer", async () => {
    let release!: (message: ReturnType<typeof fauxAssistantMessage>) => void;
    let started!: () => void;
    const requestStarted = new Promise<void>((resolve) => (started = resolve));
    const gate = new Promise<ReturnType<typeof fauxAssistantMessage>>((resolve) => (release = resolve));
    const { host } = await hostWithRoles(
      { "reviewer.md": REVIEWER, "planner.md": PLANNER },
      {
        answers: [
          "first answer",
          () => {
            started();
            return gate;
          },
        ],
      },
    );
    const client = await connectTo(defer, host);
    const raw = await socketTo(host);

    await client.controller.createConversation({ kind: "chat" }, "first", { agent: "reviewer" });
    const id = client.view.current().conversation!.conversation.id;
    await waitIdle(client, "first answer");

    await client.controller.submit("second", "followUp");
    // The request is prepared under reviewer before the switch lands.
    await requestStarted;
    expect(await call(raw, "setAgent", { conversationId: id, agent: "planner" })).toMatchObject({ ok: true });
    release(fauxAssistantMessage("answer from reviewer"));
    await waitIdle(client, "answer from reviewer");

    const forked = await call(raw, "fork", { conversationId: id, entryId: await newestEntryId(host, id) });
    expect(forked).toMatchObject({ ok: true });
    const forkId = Number((forked as { value: { conversationId: number } }).value.conversationId) as ConversationId;
    // The answer was generated by reviewer, but its entry commit follows the
    // switch — the fork copies the config as of that entry.
    expect(await summaryOf(client, forkId)).toMatchObject({ role: "reviewer", currentAgent: "planner" });
    expect(await agentOf(host, forkId)).toMatchObject({ instructions: "Plan it." });
  });
});

/** Find a summary without waiting; used inside waitForView predicates. */
function summaryOfNow(view: DurableView, target: ConversationId): ConversationSummary | undefined {
  const walk = (node: ConversationNode): ConversationSummary | undefined =>
    node.summary.id === target ? node.summary : node.children.map(walk).find((found) => found !== undefined);
  return [...view.organized.chats, ...view.organized.projects.flatMap((entry) => entry.conversations)]
    .map(walk)
    .find((found) => found !== undefined);
}
