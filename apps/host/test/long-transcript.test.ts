import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { describe, expect, it } from "vitest";
import { isBusy } from "@pinomad/protocol/transcript.ts";
import { connectTo, startChat, startFauxHost, useCleanups, waitForView } from "./support.ts";

const defer = useCleanups();
const context = BACKGROUND_CONTEXT;

// Durable's conversation view defaults to a window of the newest 50–100
// entries; clients have no paging, so the stream must carry all of them.
describe("long transcript", () => {
  it("streams every entry of a conversation longer than Durable's default window", async () => {
    const host = await startFauxHost(defer);
    const writer = await connectTo(defer, host);
    const id = await startChat(writer, "first");
    await waitForView(writer.view, (view) => !isBusy(view.conversation!));

    const extra = 150;
    const total = writer.view.current().conversation!.entries.length + extra;
    await host.harness.commit(async (tx) => {
      for (let index = 0; index < extra; index += 1) {
        await tx.appendEntry(id, { kind: "pi.user", model: [{ role: "user", content: `m${index}`, timestamp: index }] });
      }
    }, context);

    const reader = await connectTo(defer, host);
    await reader.controller.switchConversation(id);
    await waitForView(reader.view, (view) => view.conversation?.entries.length === total);
    expect(reader.view.current().conversation!.entries[0]!.kind).toBe("pi.user");
  });
});
