// The client side of plugin reloads (5.35, ADR-0050): a `plugins` frame
// replaces `view.host.plugins` and (5.36) the shared documents the hello
// declared, and `bundle` names the hash it wants from a host that knows the field.
import type { ConversationId } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { PROTOCOL, type ClientFrame, type PluginInfo } from "../src/frames.ts";
import { connectRemoteDurable, type RemoteDurable } from "../src/remote-durable.ts";
import type { FrameConnection, FrameHandlers, FrameTransport } from "../src/transport.ts";

const hash = (digit: string) => digit.repeat(64);
const PANEL: PluginInfo = { name: "panel", api: 1, web: { hash: hash("a"), size: 10 } };

const SNAPSHOTS: Record<string, unknown> = {
  conversations: [],
  index: { projects: [], conversations: [] },
  devices: { devices: [] },
  mcp: null,
  models: [],
  auth: { logins: [] },
  providers: { providers: [], logins: [] },
  settings: { defaultModel: null, defaultThinkingLevel: "off", steeringMode: "all", followUpMode: "all", hostName: "Testbox" },
  agents: { roles: [], problems: [] },
  upgrade: { blocked: null, checks: [] },
};

type DocDecl = { readonly kind: string };

/**
 * A host announcing `plugins` and `docs` at `minor`, answering every call with
 * `{ code: "x" }` and every subscribe with a snapshot — except a `doc:` stream
 * whose kind is not in `shared`, which it ends as an unknown document.
 */
function fakeHost(minor: number, plugins: readonly PluginInfo[], docs: readonly DocDecl[] = []) {
  let active: FrameHandlers | undefined;
  const sent: ClientFrame[] = [];
  const shared = new Set(docs.map((doc) => doc.kind));
  const transport: FrameTransport = {
    label: "fake",
    open(handlers): FrameConnection {
      active = handlers;
      const hello = {
        type: "hello",
        protocol: { major: PROTOCOL.major, minor },
        session: { id: "fake", directory: "" },
        models: [],
        docs,
        toolPresentations: {},
        plugins,
      };
      queueMicrotask(() => handlers.message(JSON.stringify(hello)));
      return {
        send(data) {
          const frame = JSON.parse(data) as ClientFrame;
          sent.push(frame);
          if (frame.type === "subscribe" && frame.stream.startsWith("doc:")) {
            const kind = frame.stream.slice("doc:".length, frame.stream.lastIndexOf(":"));
            const reply = shared.has(kind)
              ? { type: "snapshot", stream: frame.stream, value: { of: frame.stream } }
              : { type: "ended", stream: frame.stream, reason: `Unknown document ${kind}` };
            queueMicrotask(() => handlers.message(JSON.stringify(reply)));
          } else if (frame.type === "subscribe") {
            queueMicrotask(() => handlers.message(JSON.stringify({ type: "snapshot", stream: frame.stream, value: SNAPSHOTS[frame.stream] ?? null })));
          } else if (frame.type === "call") {
            queueMicrotask(() => handlers.message(JSON.stringify({ type: "result", id: frame.id, ok: true, value: { code: "x" } })));
          }
        },
        close() {
          queueMicrotask(() => handlers.closed(1000));
        },
      };
    },
  };
  return { transport, sent, shared, push: (frame: unknown) => active!.message(JSON.stringify(frame)) };
}

const id = (value: number): ConversationId => value as ConversationId;

const connect = (host: ReturnType<typeof fakeHost>): Promise<RemoteDurable> =>
  connectRemoteDurable({ transport: host.transport, reconnectDelayMs: { min: 20, max: 20 } });

const subscribed = (sent: readonly ClientFrame[], type: "subscribe" | "unsubscribe") =>
  sent.flatMap((frame) => (frame.type === type && frame.stream.startsWith("doc:") ? [frame.stream] : []));

/** Settles the fake host's queued replies and the view's microtask notification. */
const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

const bundleArgs = (sent: readonly ClientFrame[]) =>
  sent.flatMap((frame) => (frame.type === "call" && frame.method === "pluginBundle" ? [frame.args] : []));

describe("remote plugins", () => {
  it("replaces the hello's list with each plugins frame and tells view subscribers", async () => {
    const host = fakeHost(PROTOCOL.minor, [PANEL]);
    const remote = await connect(host);
    expect(remote.view.current().host?.plugins).toEqual([PANEL]);
    const seen: (readonly PluginInfo[] | undefined)[] = [];
    remote.view.subscribe(() => seen.push(remote.view.current().host?.plugins));

    const changed = { ...PANEL, web: { hash: hash("b"), size: 12 } };
    const added: PluginInfo = { name: "tools", api: 1 };
    host.push({ type: "plugins", plugins: [changed, added] });
    expect(remote.view.current().host?.plugins).toEqual([changed, added]);
    // Listeners hear about a burst of frames once, a microtask later.
    await Promise.resolve();
    expect(seen).toEqual([[changed, added]]);

    host.push({ type: "plugins", plugins: [] });
    expect(remote.view.current().host).not.toHaveProperty("plugins");
    expect(remote.view.current().connection).toBe("connected");
    remote.close();
  });

  it("drops malformed entries as the hello does, keeps unknown fields, and ignores a frame without a list", async () => {
    const host = fakeHost(PROTOCOL.minor, [PANEL]);
    const remote = await connect(host);
    const future = { name: "future", api: 2, ui: { slots: ["x"] } };
    host.push({
      type: "plugins",
      plugins: [future, { name: "", api: 1 }, { name: "bad", api: 1, web: { hash: "nothex", size: 1 } }, { name: "null-web", api: 1, web: null }, 7],
      extra: true,
    });
    expect(remote.view.current().host?.plugins).toEqual([future]);
    host.push({ type: "plugins", plugins: "none" });
    expect(remote.view.current().host?.plugins).toEqual([future]);
    expect(remote.view.current().connection).toBe("connected");
    remote.close();
  });

  it("names the bundle's hash for a 5.35 host and leaves it off for a 5.34 one", async () => {
    const current = fakeHost(PROTOCOL.minor, [PANEL]);
    const remote = await connect(current);
    await remote.plugins.bundle("panel", PANEL.web!.hash);
    await remote.plugins.bundle("panel");
    expect(bundleArgs(current.sent)).toEqual([{ name: "panel", hash: PANEL.web!.hash }, { name: "panel" }]);
    remote.close();

    const older = fakeHost(34, [PANEL]);
    const old = await connect(older);
    await old.plugins.bundle("panel", PANEL.web!.hash);
    expect(bundleArgs(older.sent)).toEqual([{ name: "panel" }]);
    // A 5.34 host never sends the frame; one that did is not believed.
    older.push({ type: "plugins", plugins: [] });
    expect(old.view.current().host?.plugins).toEqual([PANEL]);
    old.close();
  });

  it("follows the shown and side conversations onto a state a reload starts sharing, and off one it stops sharing", async () => {
    const BOARD = "plugin.notes.board";
    const host = fakeHost(PROTOCOL.minor, [PANEL]);
    const remote = await connect(host);
    await remote.controller.switchConversation(id(1));
    await remote.controller.showSide(id(2));
    expect(subscribed(host.sent, "subscribe")).toEqual([]);

    host.shared.add(BOARD);
    host.push({ type: "plugins", plugins: [PANEL], docs: [{ kind: BOARD }] });
    await settle();
    expect(subscribed(host.sent, "subscribe")).toEqual([`doc:${BOARD}:1`, `doc:${BOARD}:2`]);
    expect(remote.view.current().docs).toEqual([{ kind: BOARD, value: { of: `doc:${BOARD}:1` } }]);
    expect(remote.view.current().side?.docs).toEqual([{ kind: BOARD, value: { of: `doc:${BOARD}:2` } }]);

    // The host stops the streams first (a null snapshot), then sends the list without the state.
    host.shared.delete(BOARD);
    host.push({ type: "snapshot", stream: `doc:${BOARD}:1`, value: null });
    host.push({ type: "snapshot", stream: `doc:${BOARD}:2`, value: null });
    host.push({ type: "plugins", plugins: [PANEL], docs: [] });
    await settle();
    expect(remote.view.current().docs).toEqual([]);
    expect(remote.view.current().side?.docs).toEqual([]);
    // Released, so leaving the conversations later sends nothing more for it.
    expect(subscribed(host.sent, "unsubscribe")).toEqual([`doc:${BOARD}:1`, `doc:${BOARD}:2`]);
    remote.close();
  });

  it("opens another conversation without the state a reload stopped sharing", async () => {
    const BOARD = "plugin.notes.board";
    const host = fakeHost(PROTOCOL.minor, [PANEL], [{ kind: BOARD }]);
    const remote = await connect(host);
    await remote.controller.switchConversation(id(1));
    host.shared.delete(BOARD);
    host.push({ type: "snapshot", stream: `doc:${BOARD}:1`, value: null });
    host.push({ type: "plugins", plugins: [], docs: [] });
    await settle();

    await remote.controller.switchConversation(id(2));
    expect(remote.view.current().conversation).toBeDefined();
    expect(subscribed(host.sent, "subscribe")).toEqual([`doc:${BOARD}:1`]);
    remote.close();
  });

  it("keeps the hello's documents for a frame without a list of them, as a 5.35 host sends", async () => {
    const BOARD = "plugin.notes.board";
    const host = fakeHost(35, [PANEL], [{ kind: BOARD }]);
    const remote = await connect(host);
    await remote.controller.switchConversation(id(1));
    host.push({ type: "plugins", plugins: [] });
    host.push({ type: "plugins", plugins: [], docs: "none" });
    await settle();
    expect(remote.view.current().host).not.toHaveProperty("plugins");
    expect(remote.view.current().docs).toEqual([{ kind: BOARD, value: { of: `doc:${BOARD}:1` } }]);
    await remote.controller.switchConversation(id(2));
    expect(subscribed(host.sent, "subscribe")).toEqual([`doc:${BOARD}:1`, `doc:${BOARD}:2`]);
    remote.close();
  });
});

describe("an announced document the host refuses", () => {
  const BOARD = "plugin.notes.board";
  const TODO = "todo.list";

  it("keeps the shown conversation when a document a plugins frame announced was unshared again before the subscribe", async () => {
    const host = fakeHost(PROTOCOL.minor, [PANEL], [{ kind: TODO }]);
    const remote = await connect(host);
    await remote.controller.switchConversation(id(1));
    // Announced, but a second reload took it back before the subscribe arrived: the host ends it as unknown.
    host.push({ type: "plugins", plugins: [PANEL], docs: [{ kind: TODO }, { kind: BOARD }] });
    await settle();
    expect(host.sent).toContainEqual({ type: "subscribe", stream: `doc:${BOARD}:1` });
    expect(remote.view.current().conversation).toBeDefined();
    expect(remote.view.current().docs.map((doc) => doc.kind)).toEqual([TODO]);

    // The conversation's other streams still reach the view.
    host.push({ type: "snapshot", stream: `doc:${TODO}:1`, value: { items: ["later"] } });
    await settle();
    expect(remote.view.current().docs).toEqual([{ kind: TODO, value: { items: ["later"] } }]);
    expect(remote.view.current().connection).toBe("connected");
    remote.close();
  });

  it("opens a conversation whose hello-announced document the host no longer knows", async () => {
    const host = fakeHost(PROTOCOL.minor, [PANEL], [{ kind: TODO }, { kind: BOARD }]);
    host.shared.delete(BOARD);
    const remote = await connect(host);
    await remote.controller.switchConversation(id(1));
    await settle();
    expect(remote.view.current().conversation).toBeDefined();
    expect(remote.view.current().docs.map((doc) => doc.kind)).toEqual([TODO]);
    remote.close();
  });

  it("still closes the shown conversation when its own stream ends, or a document stream ends for another reason", async () => {
    const host = fakeHost(PROTOCOL.minor, [PANEL], [{ kind: TODO }]);
    const remote = await connect(host);
    await remote.controller.switchConversation(id(1));
    host.push({ type: "ended", stream: "conversation:1", reason: "Conversation 1 does not exist" });
    await settle();
    expect(remote.view.current().conversation).toBeUndefined();

    await remote.controller.switchConversation(id(2));
    expect(remote.view.current().conversation).toBeDefined();
    host.push({ type: "ended", stream: `doc:${TODO}:2`, reason: "Conversation 2 does not exist" });
    await settle();
    expect(remote.view.current().conversation).toBeUndefined();
    remote.close();
  });
});
