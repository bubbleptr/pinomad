// Two hosts run at once: focus moves only the conversation subscriptions, a
// failed third host stays contained, and no connection is torn down.
import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { RemoteDurable, RemoteDurableOptions } from "@pinomad/protocol/remote-durable.ts";
import { generateKeyPair } from "@pinomad/protocol/noise.ts";
import { toBase64Url } from "@pinomad/protocol/secure-channel.ts";
import type { StoredHost } from "@pinomad/client/stored-host.ts";
import { HostRuntimes } from "./App.tsx";
import { createHostRuntimeRegistry, HostRuntimesContext } from "./entities/host/host-runtimes.ts";
import { HostsContext } from "./entities/host/host-store.ts";
import { fakeHosts, fakeRemote, fakeView, HOME_HOST, DEVBOX_HOST } from "./test/story-fixtures.tsx";

const id = (value: number): ConversationId => value as ConversationId;

const THIRD_HOST: StoredHost = {
  url: "wss://c.example/secure",
  hostKey: toBase64Url(generateKeyPair().publicKey),
  privateKey: toBase64Url(generateKeyPair().privateKey),
  name: "third",
};

const connected = (conversationId: number): RemoteDurable => {
  const view = fakeView({
    connection: "connected",
    conversation: {
      ...fakeView().conversation!,
      conversation: { id: id(conversationId) },
    },
  });
  return { ...fakeRemote(view), close: vi.fn() };
};

describe("HostRuntimes", () => {
  it("moves focus between hosts without closing either connection", async () => {
    const remoteA = connected(1);
    const remoteB = connected(1);
    const closeA = vi.spyOn(remoteA, "close");
    const closeB = vi.spyOn(remoteB, "close");
    const connect = vi.fn((options: RemoteDurableOptions) => {
      const url = "candidates" in options ? options.candidates[0]?.url ?? "" : "";
      if (url.includes("kieran-mbp")) return Promise.resolve(remoteA);
      return Promise.resolve(remoteB);
    });
    const registry = createHostRuntimeRegistry();
    const hosts = [HOME_HOST, DEVBOX_HOST];
    const hostState = fakeHosts(hosts, HOME_HOST.hostKey);
    const { rerender } = render(
      <HostsContext.Provider value={hostState}>
        <HostRuntimesContext.Provider value={registry}>
          <HostRuntimes
            hosts={hosts}
            focus={{ hostKey: HOME_HOST.hostKey, conversationId: id(2) }}
            connect={connect}
          />
        </HostRuntimesContext.Provider>
      </HostsContext.Provider>,
    );

    await waitFor(() =>
      expect(remoteA.controller.switchConversation).toHaveBeenCalledWith(id(2)),
    );
    await waitFor(() => expect(remoteB.controller.clearConversation).toHaveBeenCalled());
    expect(closeA).not.toHaveBeenCalled();
    expect(closeB).not.toHaveBeenCalled();

    rerender(
      <HostsContext.Provider value={hostState}>
        <HostRuntimesContext.Provider value={registry}>
          <HostRuntimes
            hosts={hosts}
            focus={{ hostKey: DEVBOX_HOST.hostKey, conversationId: id(3) }}
            connect={connect}
          />
        </HostRuntimesContext.Provider>
      </HostsContext.Provider>,
    );

    await waitFor(() =>
      expect(remoteB.controller.switchConversation).toHaveBeenCalledWith(id(3)),
    );
    await waitFor(() => expect(remoteA.controller.clearConversation).toHaveBeenCalled());
    expect(closeA).not.toHaveBeenCalled();
    expect(closeB).not.toHaveBeenCalled();
  });

  it("contains a failed host without disturbing the ready ones", async () => {
    const remoteA = connected(1);
    const registry = createHostRuntimeRegistry();
    const hosts = [HOME_HOST, THIRD_HOST];
    const hostState = fakeHosts(hosts, HOME_HOST.hostKey);
    const connect = vi.fn((options: RemoteDurableOptions) => {
      const url = "candidates" in options ? options.candidates[0]?.url ?? "" : "";
      return url.includes("c.example")
        ? Promise.reject(new Error("third host offline"))
        : Promise.resolve(remoteA);
    });
    const { rerender } = render(
      <HostsContext.Provider value={hostState}>
        <HostRuntimesContext.Provider value={registry}>
          <HostRuntimes
            hosts={hosts}
            focus={{ hostKey: HOME_HOST.hostKey, conversationId: id(2) }}
            connect={connect}
          />
        </HostRuntimesContext.Provider>
      </HostsContext.Provider>,
    );

    await waitFor(() => expect(registry.get(THIRD_HOST.hostKey)?.phase).toBe("failed"));
    await waitFor(() =>
      expect(remoteA.controller.switchConversation).toHaveBeenCalledWith(id(2)),
    );
    // Focusing away from the failed host still lands on the healthy one.
    rerender(
      <HostsContext.Provider value={hostState}>
        <HostRuntimesContext.Provider value={registry}>
          <HostRuntimes hosts={hosts} focus={{ hostKey: HOME_HOST.hostKey }} connect={connect} />
        </HostRuntimesContext.Provider>
      </HostsContext.Provider>,
    );
    expect(registry.get(HOME_HOST.hostKey)?.phase).toBe("ready");
    expect(registry.get(THIRD_HOST.hostKey)?.phase).toBe("failed");
  });
});
