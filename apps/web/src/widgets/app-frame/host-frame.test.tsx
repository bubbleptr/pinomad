// The frame lives above one host's runtime: focus and connection churn move
// the main column, not the sidebar, and the global New chat picks a machine.
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useMemo, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationId } from "@earendil-works/pi-durable";
import {
  ProtocolMismatchError,
  UnauthorizedError,
  type RemoteDurable,
  type RemoteDurableOptions,
} from "@pinomad/protocol/remote-durable.ts";
import type { StoredHost } from "@pinomad/client/stored-host.ts";
import { newDraftKey } from "../../entities/composer/composer-store.ts";
import { useComposerSlot, useComposerSlotState } from "../../entities/composer/composer-context.tsx";
import { LAST_NEW_HOST_KEY } from "../../entities/host/last-new-host.ts";
import { HostRuntimes } from "../../entities/host/host-runtime.tsx";
import {
  createHostRuntimeRegistry,
  HostRuntimesContext,
  type HostRuntimeRegistry,
} from "../../entities/host/host-runtimes.ts";
import { HostsContext, type HostsState } from "../../entities/host/host-store.ts";
import type { HostFocus } from "../../entities/host/focus.ts";
import { DEVBOX_HOST, fakeHosts, fakeRemote, fakeView, HOME_HOST, PARSER_ID } from "../../test/story-fixtures.tsx";
import { HostFrame } from "./host-frame.tsx";

const id = (value: number): ConversationId => value as ConversationId;

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

function WorkbenchProbe({ hostKey }: { hostKey: string }) {
  const slot = useComposerSlot(newDraftKey);
  const { home } = useComposerSlotState(slot);
  return (
    <div
      data-testid="workbench"
      data-host={hostKey}
      data-home={home.kind === "chat" ? "chat" : home.path}
    />
  );
}

function Harness({
  hosts,
  initialFocus,
  connect,
  registry,
}: {
  hosts: readonly StoredHost[];
  initialFocus: HostFocus;
  connect: (options: RemoteDurableOptions) => Promise<RemoteDurable>;
  registry: HostRuntimeRegistry;
}) {
  const [focus, setFocus] = useState<HostFocus>(initialFocus);
  const state = useMemo<HostsState>(
    () => ({
      ...fakeHosts(hosts, null),
      focus,
      focusHost: (hostKey) => setFocus({ hostKey }),
      focusDraft: (hostKey) => setFocus({ hostKey }),
      focusConversation: (ref) => setFocus({ ...ref }),
      rememberConversation: () => {},
    }),
    [focus, hosts],
  );
  return (
    <HostsContext.Provider value={state}>
      <HostRuntimesContext.Provider value={registry}>
        <HostFrame>
          <HostRuntimes
            hosts={hosts}
            focus={focus}
            connect={connect}
            renderWorkbench={({ host }) => <WorkbenchProbe hostKey={host.hostKey} />}
          />
        </HostFrame>
        <span data-testid="focus">{focus.hostKey}:{focus.conversationId ?? "draft"}</span>
        <button type="button" onClick={() => setFocus({ hostKey: DEVBOX_HOST.hostKey })}>
          focus-devbox
        </button>
      </HostRuntimesContext.Provider>
    </HostsContext.Provider>
  );
}

const connected = (options: RemoteDurableOptions): Promise<RemoteDurable> => {
  const url = "candidates" in options ? options.candidates[0]?.url ?? "" : "";
  return Promise.resolve({ ...fakeRemote(fakeView({} as never)), close: () => {} });
};

/** Distinct remotes per host, so a cross-host call is visible to the test. */
function connectedHosts() {
  const remotes = new Map<string, RemoteDurable>();
  const connect = (options: RemoteDurableOptions): Promise<RemoteDurable> => {
    const url = "candidates" in options ? options.candidates[0]?.url ?? "" : "";
    const hostKey = url.includes("omarchy") ? DEVBOX_HOST.hostKey : HOME_HOST.hostKey;
    const remote = { ...fakeRemote(fakeView({} as never)), close: () => {} };
    remotes.set(hostKey, remote);
    return Promise.resolve(remote);
  };
  return { connect, remotes };
}

describe("the app frame across hosts", () => {
  it("keeps the sidebar mounted while focus moves between connected hosts", async () => {
    const registry = createHostRuntimeRegistry();
    render(
      <Harness
        hosts={[HOME_HOST, DEVBOX_HOST]}
        initialFocus={{ hostKey: HOME_HOST.hostKey, conversationId: id(2) }}
        connect={connected}
        registry={registry}
      />,
    );
    await waitFor(() => expect(screen.getByTestId("workbench").dataset.host).toBe(HOME_HOST.hostKey));
    await waitFor(() => expect(registry.get(DEVBOX_HOST.hostKey)?.phase).toBe("ready"));
    const sidebar = screen.getByRole("navigation");

    await userEvent.click(screen.getByRole("button", { name: "focus-devbox" }));

    await waitFor(() => expect(screen.getByTestId("workbench").dataset.host).toBe(DEVBOX_HOST.hostKey));
    expect(screen.getByRole("navigation")).toBe(sidebar);
  });

  it("lists every paired machine and opens a conversation on the machine clicked", async () => {
    const registry = createHostRuntimeRegistry();
    render(
      <Harness
        hosts={[HOME_HOST, DEVBOX_HOST]}
        initialFocus={{ hostKey: HOME_HOST.hostKey, conversationId: id(2) }}
        connect={connected}
        registry={registry}
      />,
    );
    await waitFor(() => expect(registry.get(DEVBOX_HOST.hostKey)?.phase).toBe("ready"));
    const devbox = await screen.findByRole("group", { name: "omarchy" });
    expect(screen.getByRole("group", { name: "kieran-mbp" })).toBeInTheDocument();

    await userEvent.click(within(devbox).getByRole("button", { name: "Fix the parser's trailing-comma bug" }));

    await waitFor(() => expect(screen.getByTestId("focus").textContent).toBe(`${DEVBOX_HOST.hostKey}:${PARSER_ID}`));
  });

  it("archives through the remote of the machine the row belongs to", async () => {
    const registry = createHostRuntimeRegistry();
    const { connect, remotes } = connectedHosts();
    render(
      <Harness
        hosts={[HOME_HOST, DEVBOX_HOST]}
        initialFocus={{ hostKey: HOME_HOST.hostKey, conversationId: id(2) }}
        connect={connect}
        registry={registry}
      />,
    );
    await waitFor(() => expect(registry.get(DEVBOX_HOST.hostKey)?.phase).toBe("ready"));
    const devbox = await screen.findByRole("group", { name: "omarchy" });

    await userEvent.click(within(devbox).getAllByRole("button", { name: "Conversation actions" })[0]!);
    await userEvent.click(await screen.findByRole("menuitem", { name: "Archive" }));

    expect(remotes.get(DEVBOX_HOST.hostKey)!.controller.archive).toHaveBeenCalled();
    expect(remotes.get(HOME_HOST.hostKey)!.controller.archive).not.toHaveBeenCalled();
  });

  it("starts a chat draft on the machine whose header was used", async () => {
    const registry = createHostRuntimeRegistry();
    render(
      <Harness
        hosts={[HOME_HOST, DEVBOX_HOST]}
        initialFocus={{ hostKey: HOME_HOST.hostKey, conversationId: id(2) }}
        connect={connected}
        registry={registry}
      />,
    );
    await waitFor(() => expect(registry.get(DEVBOX_HOST.hostKey)?.phase).toBe("ready"));
    registry.get(DEVBOX_HOST.hostKey)!.composer.slot(newDraftKey).setHome({ kind: "project", path: "/elsewhere" });

    await userEvent.click(await screen.findByRole("button", { name: "New chat on omarchy" }));

    await waitFor(() => expect(screen.getByTestId("focus").textContent).toBe(`${DEVBOX_HOST.hostKey}:draft`));
    await waitFor(() => expect(screen.getByTestId("workbench").dataset.home).toBe("chat"));
  });

  it("lets a machine that never connected be focused from its group", async () => {
    const registry = createHostRuntimeRegistry();
    const connect = (options: RemoteDurableOptions): Promise<RemoteDurable> => {
      const url = "candidates" in options ? options.candidates[0]?.url ?? "" : "";
      return url.includes("omarchy") ? new Promise<RemoteDurable>(() => {}) : connected(options);
    };
    render(
      <Harness
        hosts={[HOME_HOST, DEVBOX_HOST]}
        initialFocus={{ hostKey: HOME_HOST.hostKey, conversationId: id(2) }}
        connect={connect}
        registry={registry}
      />,
    );
    const devbox = await screen.findByRole("group", { name: "omarchy" });

    await userEvent.click(within(devbox).getByRole("button", { name: "No conversations available" }));

    await waitFor(() => expect(screen.getByTestId("focus").textContent).toBe(`${DEVBOX_HOST.hostKey}:draft`));
  });

  it("locates a machine from the hosts list without moving focus", async () => {
    const registry = createHostRuntimeRegistry();
    render(
      <Harness
        hosts={[HOME_HOST, DEVBOX_HOST]}
        initialFocus={{ hostKey: HOME_HOST.hostKey, conversationId: id(2) }}
        connect={connected}
        registry={registry}
      />,
    );
    await waitFor(() => expect(registry.get(DEVBOX_HOST.hostKey)?.phase).toBe("ready"));
    const devbox = await screen.findByRole("group", { name: "omarchy" });
    await userEvent.click(within(devbox).getByRole("button", { name: "Collapse omarchy" }));
    expect(within(devbox).queryByRole("button", { name: "Fix the parser's trailing-comma bug" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Hosts" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /omarchy/ }));

    expect(await within(devbox).findByRole("button", { name: "Fix the parser's trailing-comma bug" })).toBeInTheDocument();
    expect(screen.getByTestId("focus").textContent).toBe(`${HOME_HOST.hostKey}:2`);
  });

  it("keeps a pending sidebar action bound to its own machine when focus moves", async () => {
    const registry = createHostRuntimeRegistry();
    const { connect, remotes } = connectedHosts();
    render(
      <Harness
        hosts={[HOME_HOST, DEVBOX_HOST]}
        initialFocus={{ hostKey: HOME_HOST.hostKey, conversationId: id(2) }}
        connect={connect}
        registry={registry}
      />,
    );
    await waitFor(() => expect(registry.get(DEVBOX_HOST.hostKey)?.phase).toBe("ready"));
    const home = await screen.findByRole("group", { name: "kieran-mbp" });

    await userEvent.click(within(home).getByRole("button", { name: "Project actions for pinomad" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Remove project" }));
    expect(await screen.findByText("Remove project pinomad?")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "focus-devbox" }));
    await waitFor(() => expect(screen.getByTestId("workbench").dataset.host).toBe(DEVBOX_HOST.hostKey));
    await userEvent.click(screen.getByRole("button", { name: "Remove project" }));

    await waitFor(() => expect(remotes.get(HOME_HOST.hostKey)!.controller.removeProject).toHaveBeenCalled());
    expect(remotes.get(DEVBOX_HOST.hostKey)!.controller.removeProject).not.toHaveBeenCalled();
  });

  it("keeps Settings on the machine it was managing when focus moves, and switches only by its picker", async () => {
    const registry = createHostRuntimeRegistry();
    const { connect, remotes } = connectedHosts();
    render(
      <Harness
        hosts={[HOME_HOST, DEVBOX_HOST]}
        initialFocus={{ hostKey: HOME_HOST.hostKey, conversationId: id(2) }}
        connect={connect}
        registry={registry}
      />,
    );
    await waitFor(() => expect(screen.getByTestId("workbench").dataset.host).toBe(HOME_HOST.hostKey));
    await waitFor(() => expect(registry.get(DEVBOX_HOST.hostKey)?.phase).toBe("ready"));

    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    await userEvent.click(within(dialog).getByRole("button", { name: /Custom endpoint/ }));
    const name = within(dialog).getByLabelText("Name");
    await userEvent.type(name, "Host A endpoint");

    await userEvent.click(screen.getByRole("button", { name: "focus-devbox" }));
    await waitFor(() => expect(screen.getByTestId("workbench").dataset.host).toBe(DEVBOX_HOST.hostKey));
    expect(within(dialog).getByLabelText("Name")).toHaveValue("Host A endpoint");

    await userEvent.click(within(dialog).getByRole("combobox", { name: "Host" }));
    await userEvent.click(await screen.findByRole("option", { name: "omarchy" }));

    expect(within(dialog).queryByLabelText("Name")).toBeNull();
    expect(remotes.get(DEVBOX_HOST.hostKey)!.controller.saveCustomProvider).not.toHaveBeenCalled();
  });

  it("toasts a notice from a machine that is not focused, named by its machine", async () => {
    const registry = createHostRuntimeRegistry();
    render(
      <Harness
        hosts={[HOME_HOST, DEVBOX_HOST]}
        initialFocus={{ hostKey: HOME_HOST.hostKey, conversationId: id(2) }}
        connect={connected}
        registry={registry}
      />,
    );
    await waitFor(() => expect(registry.get(DEVBOX_HOST.hostKey)?.phase).toBe("ready"));
    await screen.findByRole("group", { name: "omarchy" });
    const devbox = registry.get(DEVBOX_HOST.hostKey)!;
    if (devbox.phase !== "ready") throw new Error("devbox not ready");

    act(() =>
      registry.publish(DEVBOX_HOST.hostKey, {
        ...devbox,
        view: { ...devbox.view, notices: [{ id: 41, level: "info", message: "Kept worktree pinomad/9-dirty" }] },
      }),
    );

    expect(await screen.findByText("omarchy: Kept worktree pinomad/9-dirty")).toBeInTheDocument();
  });

  it("keeps navigation reachable on a phone while the focused host is connecting", async () => {
    vi.spyOn(window, "matchMedia").mockImplementation(
      (query: string) =>
        ({
          matches: query === "(max-width: 1023px)",
          media: query,
          onchange: null,
          addEventListener: () => {},
          removeEventListener: () => {},
          addListener: () => {},
          removeListener: () => {},
          dispatchEvent: () => false,
        }) as MediaQueryList,
    );
    const registry = createHostRuntimeRegistry();
    const connect = vi.fn(() => new Promise<RemoteDurable>(() => {}));
    render(
      <Harness hosts={[HOME_HOST]} initialFocus={{ hostKey: HOME_HOST.hostKey }} connect={connect} registry={registry} />,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Open navigation" }));
    expect(await screen.findByRole("button", { name: "Settings" })).toBeInTheDocument();
    // The drawer's New chat must close the drawer on the way out.
    await userEvent.click(screen.getByRole("button", { name: "New chat" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Settings" })).toBeNull());
  });

  it("keeps the sidebar and footer while the focused host is still connecting", async () => {
    const registry = createHostRuntimeRegistry();
    const connect = vi.fn(() => new Promise<RemoteDurable>(() => {}));
    render(
      <Harness hosts={[HOME_HOST]} initialFocus={{ hostKey: HOME_HOST.hostKey }} connect={connect} registry={registry} />,
    );
    expect(await screen.findByText("Connecting")).toBeInTheDocument();
    expect(screen.getByRole("navigation")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New chat" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hosts" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    expect(within(dialog).getByText("This device")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Hosts" })).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Providers" })).toBeNull();
    expect(within(dialog).getByText("Pair a host")).toBeInTheDocument();
  });

  it("keeps the device Updates section while the focused host is connecting", async () => {
    const previous = window.pinomadDesktop;
    const status = { state: "idle" as const, currentVersion: "0.1.0" };
    window.pinomadDesktop = {
      ...(previous ?? {}),
      updates: {
        status: async () => status,
        check: async () => status,
        install: async () => status,
        onStatus: () => () => {},
      },
    } as NonNullable<typeof window.pinomadDesktop>;
    try {
      const registry = createHostRuntimeRegistry();
      const connect = vi.fn(() => new Promise<RemoteDurable>(() => {}));
      render(
        <Harness hosts={[HOME_HOST]} initialFocus={{ hostKey: HOME_HOST.hostKey }} connect={connect} registry={registry} />,
      );
      await userEvent.click(await screen.findByRole("button", { name: "Settings" }));
      const dialog = await screen.findByRole("dialog", { name: "Settings" });
      await userEvent.click(within(dialog).getByRole("button", { name: "Updates" }));
      expect(await within(dialog).findByText("Check for updates")).toBeInTheDocument();
      expect(within(dialog).queryByText("Pair a host")).toBeNull();
    } finally {
      window.pinomadDesktop = previous;
    }
  });

  it.each([
    ["a revoked pairing", () => new UnauthorizedError(), "This device isn't paired"],
    ["a protocol mismatch", () => new ProtocolMismatchError(6, 5), "Client out of date"],
  ])("keeps the frame when the focused host fails with %s", async (_name, makeError, message) => {
    const registry = createHostRuntimeRegistry();
    const connect = vi.fn(() => Promise.reject(makeError()));
    render(
      <Harness hosts={[HOME_HOST]} initialFocus={{ hostKey: HOME_HOST.hostKey }} connect={connect} registry={registry} />,
    );
    await waitFor(() => expect(screen.getByText(message, { exact: false })).toBeInTheDocument());
    expect(screen.getByRole("navigation")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New chat" })).toBeInTheDocument();
  });

  it("opens the last new host's draft from the global New chat", async () => {
    localStorage.setItem(LAST_NEW_HOST_KEY, DEVBOX_HOST.hostKey);
    const registry = createHostRuntimeRegistry();
    render(
      <Harness
        hosts={[HOME_HOST, DEVBOX_HOST]}
        initialFocus={{ hostKey: HOME_HOST.hostKey, conversationId: id(2) }}
        connect={connected}
        registry={registry}
      />,
    );
    await waitFor(() => expect(registry.get(DEVBOX_HOST.hostKey)?.phase).toBe("ready"));
    const composer = registry.get(DEVBOX_HOST.hostKey)?.composer;
    expect(composer).toBeDefined();
    composer!.slot(newDraftKey).setHome({ kind: "project", path: "/devbox-project" });

    await userEvent.click(screen.getByRole("button", { name: "New chat" }));

    await waitFor(() => expect(screen.getByTestId("focus").textContent).toBe(`${DEVBOX_HOST.hostKey}:draft`));
    await waitFor(() => expect(screen.getByTestId("workbench").dataset.host).toBe(DEVBOX_HOST.hostKey));
    expect(screen.getByTestId("workbench").dataset.home).toBe("chat");
  });
});
