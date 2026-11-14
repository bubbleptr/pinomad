// The client side of plugin reloads (5.35, ADR-0050): a `plugins` frame
// replaces `view.host.plugins`, and `bundle` names the hash it wants from a
// host that knows the field.
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

/** A host announcing `plugins` at `minor`, answering every subscribe with a snapshot and every call with `null`. */
function fakeHost(minor: number, plugins: readonly PluginInfo[]) {
  let active: FrameHandlers | undefined;
  const sent: ClientFrame[] = [];
  const transport: FrameTransport = {
    label: "fake",
    open(handlers): FrameConnection {
      active = handlers;
      const hello = {
        type: "hello",
        protocol: { major: PROTOCOL.major, minor },
        session: { id: "fake", directory: "" },
        models: [],
        docs: [],
        toolPresentations: {},
        plugins,
      };
      queueMicrotask(() => handlers.message(JSON.stringify(hello)));
      return {
        send(data) {
          const frame = JSON.parse(data) as ClientFrame;
          sent.push(frame);
          if (frame.type === "subscribe") {
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
  return { transport, sent, push: (frame: unknown) => active!.message(JSON.stringify(frame)) };
}

const connect = (host: ReturnType<typeof fakeHost>): Promise<RemoteDurable> =>
  connectRemoteDurable({ transport: host.transport, reconnectDelayMs: { min: 20, max: 20 } });

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
});
