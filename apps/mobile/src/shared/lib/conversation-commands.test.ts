import { describe, expect, test } from "vitest";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { Home } from "@pinomad/protocol/organization.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import { createAndShow, showConversation } from "./conversation-commands.ts";

type Remote = Pick<RemoteDurable, "view" | "controller">;

const CHAT: Home = { kind: "chat" };

/**
 * A fake remote: `view.current()` reads mutable state, and the controller
 * resolves while optionally mutating it — matching RemoteDurable, whose
 * command promises resolve even when the host refused (failure = a notice).
 */
function fakeRemote(shown: ConversationId | undefined) {
  const state: { shown: ConversationId | undefined; created: ConversationId | undefined } = { shown, created: undefined };
  const remote = {
    view: {
      current: () => ({
        conversation: state.shown === undefined ? undefined : { conversation: { id: state.shown } },
      }),
    },
    controller: {
      createConversation: async (_home: Home, _text: string) => {
        if (state.created !== undefined) state.shown = state.created;
      },
      switchConversation: async (id: ConversationId) => {
        state.shown = id;
      },
    },
  };
  const succeedCreate = (id: ConversationId): void => {
    state.created = id;
  };
  return { remote: remote as unknown as Remote, succeedCreate };
}

const id = (n: number): ConversationId => n as ConversationId;

describe("createAndShow", () => {
  test("resolves with the new id when the shown conversation changes", async () => {
    const { remote, succeedCreate } = fakeRemote(id(12));
    succeedCreate(id(13));
    await expect(createAndShow(remote, CHAT, "hi")).resolves.toBe(id(13));
  });

  test("rejects when nothing was shown and still nothing is", async () => {
    const { remote } = fakeRemote(undefined);
    await expect(createAndShow(remote, CHAT, "hi")).rejects.toThrow();
  });

  test("rejects when the previous conversation is still shown (create failed)", async () => {
    const { remote } = fakeRemote(id(12));
    // The host refused — resolve without switching, as RemoteDurable does.
    remote.controller.createConversation = async () => {};
    await expect(createAndShow(remote, CHAT, "hi")).rejects.toThrow("Couldn't start the conversation");
  });
});

describe("showConversation", () => {
  test("true when the shown conversation becomes the requested id", async () => {
    const { remote } = fakeRemote(id(12));
    await expect(showConversation(remote, id(13))).resolves.toBe(true);
  });

  test("false when the shown conversation stays on the previous one", async () => {
    const { remote } = fakeRemote(id(12));
    remote.controller.switchConversation = async () => {};
    await expect(showConversation(remote, id(13))).resolves.toBe(false);
  });
});
