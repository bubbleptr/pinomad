import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useCallback, useMemo, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { StoredHost } from "@pinomad/client/stored-host.ts";
import type { ConversationNode } from "@pinomad/protocol/organization.ts";
import type { RemoteDurable, RemoteDurableOptions } from "@pinomad/protocol/remote-durable.ts";
import type { DurableView } from "@pinomad/protocol/view.ts";
import { Workbench } from "./App.tsx";
import type { HostFocus } from "./entities/host/focus.ts";
import { HostRuntimes } from "./entities/host/host-runtime.tsx";
import { createHostRuntimeRegistry, HostRuntimesContext } from "./entities/host/host-runtimes.ts";
import { HostsContext } from "./entities/host/host-store.ts";
import {
  DEVBOX_HOST,
  fakeHosts,
  fakeRemote,
  fakeView,
  FORK_ID,
  forkConversation,
  HOME_HOST,
  PARSER_ID,
} from "./test/story-fixtures.tsx";

function mutableRemote(initial: DurableView = fakeView()) {
  let current = initial;
  const listeners = new Set<() => void>();
  const base = fakeRemote(current);
  const remote = {
    ...base,
    close: vi.fn(),
    view: {
      current: () => current,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  } as typeof base;
  const publish = (next: DurableView): void => {
    current = next;
    for (const listener of listeners) listener();
  };
  return { remote, publish };
}

/** The snapshot just after the fork switch, before the list names the fork. */
function withoutFork(view: DurableView): DurableView {
  const strip = (node: ConversationNode): ConversationNode => ({
    ...node,
    children: node.children.filter((child) => child.summary.id !== FORK_ID).map(strip),
  });
  return {
    ...view,
    organized: {
      ...view.organized,
      chats: view.organized.chats.map(strip),
      projects: view.organized.projects.map((project) => ({
        ...project,
        conversations: project.conversations.map(strip),
      })),
      archived: view.organized.archived.map((entry) => ({ ...entry, node: strip(entry.node) })),
    },
  };
}

function renderWorkbench(remote: RemoteDurable, focusConversation: (ref: { hostKey: string; conversationId?: ConversationId }) => void, conversationId: ConversationId = PARSER_ID) {
  const hosts = {
    ...fakeHosts([HOME_HOST], HOME_HOST.hostKey),
    focus: { hostKey: HOME_HOST.hostKey, conversationId },
    focusConversation,
  };
  return render(
    <HostsContext.Provider value={hosts}>
      <Workbench remote={remote} wsUrl="ws://test" hostKey={HOME_HOST.hostKey} framed={false} notify={false} />
    </HostsContext.Provider>,
  );
}

async function forkFromFirstRun(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Fork" }));
  const dialog = screen.getByRole("dialog");
  await user.click(within(dialog).getByRole("button", { name: "Fork" }));
}

/**
 * The real HostRuntimes + ReadyHost + Workbench composition, with focus kept
 * in React state the way App does it.
 */
function FocusHarness({
  hosts,
  remotes,
  initialFocus,
  onFocus,
  setFocusRef,
}: {
  hosts: readonly StoredHost[];
  remotes: ReadonlyMap<string, RemoteDurable>;
  initialFocus: HostFocus;
  onFocus: (focus: HostFocus) => void;
  setFocusRef: { current: (focus: HostFocus) => void };
}) {
  const [focus, setFocus] = useState(initialFocus);
  setFocusRef.current = setFocus;
  const focusConversation = useCallback(
    (ref: { hostKey: string; conversationId?: ConversationId }) => {
      const next: HostFocus =
        ref.conversationId === undefined ? { hostKey: ref.hostKey } : { hostKey: ref.hostKey, conversationId: ref.conversationId };
      setFocus(next);
      onFocus(next);
    },
    [onFocus],
  );
  const hostState = useMemo(
    () => ({ ...fakeHosts(hosts, null), focus, focusConversation }),
    [hosts, focus, focusConversation],
  );
  const registry = useMemo(createHostRuntimeRegistry, []);
  const connect = useCallback(
    (options: RemoteDurableOptions) => {
      const url = "candidates" in options ? options.candidates[0]?.url ?? "" : "";
      const host = hosts.find((candidate) => url.includes(new URL(candidate.url).hostname));
      const remote = host === undefined ? undefined : remotes.get(host.hostKey);
      return remote === undefined ? Promise.reject(new Error(`no remote for ${url}`)) : Promise.resolve(remote);
    },
    [hosts, remotes],
  );
  return (
    <HostsContext.Provider value={hostState}>
      <HostRuntimesContext.Provider value={registry}>
        <HostRuntimes
          hosts={hosts}
          focus={focus}
          connect={connect}
          renderWorkbench={({ host, remote, beginFork, endFork }) => (
            <Workbench
              remote={remote}
              wsUrl={host.url}
              hostKey={host.hostKey}
              framed={false}
              notify={false}
              onForkStart={beginFork}
              onForkEnd={endFork}
            />
          )}
        />
      </HostRuntimesContext.Provider>
    </HostsContext.Provider>
  );
}

function renderHarness(
  remotes: Map<string, RemoteDurable>,
  onFocus: (focus: HostFocus) => void,
  setFocusRef: { current: (focus: HostFocus) => void },
  initialFocus: HostFocus = { hostKey: HOME_HOST.hostKey, conversationId: PARSER_ID },
) {
  return render(
    <FocusHarness
      hosts={[HOME_HOST, DEVBOX_HOST]}
      remotes={remotes}
      initialFocus={initialFocus}
      onFocus={onFocus}
      setFocusRef={setFocusRef}
    />,
  );
}

describe("creating a fork in the host runtime", () => {
  it("holds the parent until the fork summary arrives, then does not steal focus after a return", async () => {
    const user = userEvent.setup();
    const { remote: remoteA, publish } = mutableRemote();
    const { remote: remoteB } = mutableRemote();
    let releaseSummary!: () => void;
    const summaryGate = new Promise<void>((resolve) => {
      releaseSummary = resolve;
    });
    let releaseSubmit!: () => void;
    const submitGate = new Promise<void>((resolve) => {
      releaseSubmit = resolve;
    });
    remoteA.controller.fork = vi.fn(async () => {
      // The host switched main before the conversation list names the fork.
      publish(withoutFork(fakeView({ conversation: forkConversation() })));
      await summaryGate;
      publish(fakeView({ conversation: forkConversation() }));
      await submitGate;
    });
    const onFocus = vi.fn();
    const setFocus = { current: (_focus: HostFocus) => {} };
    renderHarness(new Map([[HOME_HOST.hostKey, remoteA], [DEVBOX_HOST.hostKey, remoteB]]), onFocus, setFocus);

    await screen.findByRole("button", { name: "Fork" });
    await forkFromFirstRun(user);

    // The fork is shown but absent from organized: hold, do not switch back.
    await waitFor(() => expect(remoteA.view.current().conversation?.conversation.id).toBe(FORK_ID));
    expect(onFocus).not.toHaveBeenCalled();
    expect(remoteA.controller.switchConversation).not.toHaveBeenCalledWith(PARSER_ID);

    // The list catches up and the fork is adopted.
    await act(async () => releaseSummary());
    await waitFor(() =>
      expect(onFocus).toHaveBeenCalledWith({ hostKey: HOME_HOST.hostKey, conversationId: FORK_ID }),
    );

    // The reader goes back to the parent while the first submit is still pending.
    act(() => {
      setFocus.current({ hostKey: HOME_HOST.hostKey, conversationId: PARSER_ID });
      publish(fakeView());
    });
    await act(async () => releaseSubmit());

    // The late fork call must not focus the fork again.
    await waitFor(() => expect(screen.getByRole("button", { name: "Fork" })).not.toBeDisabled());
    expect(onFocus).toHaveBeenCalledTimes(1);
    expect(onFocus).toHaveBeenCalledWith({ hostKey: HOME_HOST.hostKey, conversationId: FORK_ID });
  });

  it("does not focus A's late fork after focus moved to host B", async () => {
    const user = userEvent.setup();
    const { remote: remoteA, publish } = mutableRemote();
    const { remote: remoteB } = mutableRemote();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    remoteA.controller.fork = vi.fn(async () => {
      await gate;
      publish(fakeView({ conversation: forkConversation() }));
    });
    const onFocus = vi.fn();
    const setFocus = { current: (_focus: HostFocus) => {} };
    renderHarness(new Map([[HOME_HOST.hostKey, remoteA], [DEVBOX_HOST.hostKey, remoteB]]), onFocus, setFocus);

    await screen.findByRole("button", { name: "Fork" });
    await forkFromFirstRun(user);

    act(() => setFocus.current({ hostKey: DEVBOX_HOST.hostKey, conversationId: 3 as ConversationId }));
    await waitFor(() => expect(remoteA.controller.clearConversation).toHaveBeenCalled());

    await act(async () => release());
    await waitFor(() => expect(remoteA.view.current().conversation?.conversation.id).toBe(FORK_ID));
    expect(onFocus).not.toHaveBeenCalledWith({ hostKey: HOME_HOST.hostKey, conversationId: FORK_ID });
  });
});

describe("fork reentrancy", () => {
  it("disables the Fork entry while a create is pending and rejects a second create", async () => {
    const user = userEvent.setup();
    const { remote, publish } = mutableRemote();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    remote.controller.fork = vi.fn(async () => {
      await gate;
      publish(fakeView({ conversation: forkConversation() }));
    });
    renderWorkbench(remote, vi.fn());

    await forkFromFirstRun(user);
    const forkAction = screen.getByRole("button", { name: "Fork" });
    await waitFor(() => expect(forkAction).toBeDisabled());

    // The disabled row cannot open a second dialog; the callback is guarded too.
    await user.click(forkAction);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(remote.controller.fork).toHaveBeenCalledTimes(1);

    await act(async () => release());
  });
});
