import type { Context } from "@earendil-works/chord";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { StorageWrite } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { isBusy } from "@pinomad/protocol/transcript.ts";
import { connectTo, startChat, startFauxHost, tempDir, useCleanups, waitForView } from "./support.ts";

const defer = useCleanups();

describe("session failure", () => {
  it("closes the host session when storage writes start failing", async () => {
    const project = await tempDir();
    defer(project.remove);
    let failWrites = false;
    const host = await startFauxHost(defer, {
      dataDir: project.path,
      projects: [project.path],
      openStorage: async (path) => {
        const storage = await openNodeSqliteStorage(path);
        // Class methods must bind to the real instance; only commit fails.
        return new Proxy(storage, {
          get(target, prop) {
            if (prop === "commit") {
              return (writes: readonly StorageWrite[], context: Context) =>
                failWrites ? Promise.reject(new Error("injected storage failure")) : target.commit(writes, context);
            }
            const value = Reflect.get(target, prop);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
    });
    const client = await connectTo(defer, host);
    await startChat(client, "first");
    await waitForView(client.view, (view) => !isBusy(view.conversation!));

    failWrites = true;
    await client.controller.createConversation({ kind: "chat" }, "second").catch(() => {});
    const end = await host.closed;
    expect(end.reason).toBe("failed");
  });
});
