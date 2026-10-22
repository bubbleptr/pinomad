// Host-declared slash commands (issue #254): `listCommands` lists the host's
// registry for a conversation, `runCommand` runs one — `/compact [instructions]`
// is the only builtin and reaches `Conversation.compact`.
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { CallMethods, ServerFrame } from "@pinomad/protocol/frames.ts";
import { isBusy, transcript } from "@pinomad/protocol/transcript.ts";
import { listCommands, runCommand } from "../src/commands.ts";
import type { OpenedHost } from "../src/host.ts";
import { connectTo, startChat, startFauxHost, useCleanups, waitForView } from "./support.ts";

const defer = useCleanups();
const context = BACKGROUND_CONTEXT;
let nextCall = 1;

afterEach(() => {
  vi.restoreAllMocks();
});

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

/** A host with one settled Chat conversation, plus a raw socket to call it over. */
async function hostWithChat() {
  const host = await startFauxHost(defer);
  const client = await connectTo(defer, host);
  const id = await startChat(client, "hi");
  await waitForView(client.view, (view) => !isBusy(view.conversation!) && transcript(view.conversation!).length >= 2);
  return { host, id, raw: await socketTo(host) };
}

describe("command registry", () => {
  it("declares /compact as the only builtin", () => {
    expect(listCommands()).toEqual({
      commands: [
        {
          name: "compact",
          description: "Summarize older context to free up space",
          argumentHint: "[instructions]",
          source: "builtin",
        },
      ],
    });
  });

  it("runs /compact with the trimmed args as instructions, none when blank", async () => {
    const compact = vi.fn(async () => {});
    await runCommand({ compact }, "compact", "  keep API notes \n");
    await runCommand({ compact }, "compact", "   ");
    await runCommand({ compact }, "compact", undefined);
    expect(compact.mock.calls).toEqual([["keep API notes"], [undefined], [undefined]]);
  });

  it("rejects an unknown name", async () => {
    const compact = vi.fn(async () => {});
    await expect(runCommand({ compact }, "nope", undefined)).rejects.toThrow("Unknown command: /nope");
    expect(compact).not.toHaveBeenCalled();
  });
});

describe("listCommands / runCommand over the gateway", () => {
  it("lists the builtin commands for a conversation", async () => {
    const { id, raw } = await hostWithChat();
    const result = await call(raw, "listCommands", { conversationId: id });
    expect(result).toMatchObject({ ok: true, value: listCommands() });
  });

  it("fails for a conversation that does not exist", async () => {
    const { raw } = await hostWithChat();
    expect(await call(raw, "listCommands", { conversationId: 999 as never })).toMatchObject({
      ok: false,
      error: "Conversation 999 does not exist",
    });
  });

  it("runs /compact through Conversation.compact and reports the outcome", async () => {
    const { host, id, raw } = await hostWithChat();
    const conversation = await host.harness.conversation(id, context);
    const compact = vi.spyOn(Object.getPrototypeOf(conversation) as { compact: (...args: unknown[]) => unknown }, "compact");

    const result = await call(raw, "runCommand", { conversationId: id, name: "compact", args: "keep API notes" });
    expect(result).toEqual({ type: "result", id: result.id, ok: true, value: null });
    expect(compact).toHaveBeenCalledTimes(1);
    expect(compact.mock.calls[0]![0]).toBe("keep API notes");

    // The same completion notice the `compact` call sends.
    for (;;) {
      if (raw.frames.some((frame) => frame.type === "notice" && frame.message.startsWith("Compaction "))) break;
      await once(raw.socket, "message");
    }
  });

  it("fails an unknown command without touching the conversation", async () => {
    const { host, id, raw } = await hostWithChat();
    const conversation = await host.harness.conversation(id, context);
    const compact = vi.spyOn(Object.getPrototypeOf(conversation) as { compact: (...args: unknown[]) => unknown }, "compact");

    expect(await call(raw, "runCommand", { conversationId: id, name: "nope" })).toMatchObject({
      ok: false,
      error: "Unknown command: /nope",
    });
    expect(compact).not.toHaveBeenCalled();
  });
});
