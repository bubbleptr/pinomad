import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { ConversationId } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import type { ClientFrame, ServerFrame } from "../src/frames.ts";
import { connectRemoteDurable } from "../src/remote-durable.ts";
import { transcript } from "../src/transcript.ts";
import type { FrameConnection, FrameTransport } from "../src/transport.ts";

// Replays the frames recorded by apps/host/test/protocol-contract.test.ts
// (ADR-0018 §5): every client consumes the same recording, so a host-side
// change that breaks this client shows up here, not in production.
const FRAMES = fileURLToPath(new URL("./fixtures/host-frames.json", import.meta.url));

/**
 * The recorded host: hello on open, each stream's recorded frames on
 * subscribe, the recorded call results (re-tagged with the request's id) on
 * call.
 */
function replayTransport(frames: readonly ServerFrame[]): FrameTransport {
  const results = [...frames.filter((frame): frame is Extract<ServerFrame, { type: "result" }> => frame.type === "result")];
  return {
    label: "recorded host",
    open(handlers): FrameConnection {
      const deliver = (frame: ServerFrame) => queueMicrotask(() => handlers.message(JSON.stringify(frame)));
      deliver(frames.find((frame) => frame.type === "hello")!);
      return {
        send(data) {
          const frame = JSON.parse(data) as ClientFrame;
          if (frame.type === "subscribe") {
            for (const recorded of frames) {
              if (
                (recorded.type === "snapshot" || recorded.type === "ops" || recorded.type === "ended")
                && recorded.stream === frame.stream
              ) {
                deliver(recorded);
              }
            }
          } else if (frame.type === "call") {
            const result = results.shift();
            if (result !== undefined) deliver({ ...result, id: frame.id });
          }
        },
        close() {},
      };
    },
  };
}

describe("contract replay", () => {
  it("connects to the recorded host and shows the recorded conversation", async () => {
    const frames = JSON.parse(await readFile(FRAMES, "utf8")) as ServerFrame[];
    const remote = await connectRemoteDurable({ transport: replayTransport(frames) });
    try {
      expect(remote.view.current().connection).toBe("connected");
      const id = (frames.find((frame) => frame.type === "result")! as { value: { conversationId: ConversationId } })
        .value.conversationId;

      await remote.controller.toggleTasks();
      expect(remote.view.current().tasks).toBeDefined();

      await remote.controller.switchConversation(id);
      const conversation = remote.view.current().conversation;
      expect(conversation?.conversation.id).toBe(id);
      const lines = transcript(conversation!);
      expect(lines[0]).toMatchObject({ role: "user", text: "contract run" });
      expect(lines.at(-1)).toMatchObject({ role: "assistant", text: "contract done" });
      // The recorded run wrote a file through the wrapped tool, so a
      // tool-result entry with pinomad.diff details must have replayed.
      const toolResult = conversation!.entries.find((entry) => entry.kind === "pi.tool-result");
      expect((toolResult?.model?.[0] as { details?: { patch?: string } } | undefined)?.details?.patch).toContain("note.txt");
    } finally {
      remote.close();
    }
  });
});
