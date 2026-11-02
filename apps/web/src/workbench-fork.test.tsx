import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useCallback, useMemo, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ConversationId, ConversationView, EntryRecord } from "@earendil-works/pi-durable";
import type { StoredHost } from "@pinomad/client/stored-host.ts";
import type { ConversationNode, Organized } from "@pinomad/protocol/organization.ts";
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
  SECOND_FORK_ID,
  settledConversation,
  SUBAGENT_ID,
  subagentConversation,
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
  return { remote, publish, current: () => current };
}

/** Two settled runs, so each has its own Fork entry. */
function twoRunParent(): ConversationView {
  const base = settledConversation();
  const now = Date.now();
  const extra = [
    {
      id: 900_001,
      conversationId: PARSER_ID,
      kind: "pi.user",
      model: [{ role: "user", content: "second run", timestamp: now }],
    },
    {
      id: 900_002,
      conversationId: PARSER_ID,
      kind: "pi.assistant",
      model: [
        {
          role: "assistant",
          content: [{ type: "text", text: "second answer" }],
          stopReason: "stop",
          timestamp: now,
        },
      ],
    },
  ] as unknown as EntryRecord[];
  return { ...base, entries: [...base.entries, ...extra] };
}

/** Last assistant entry of each run, in run order — the Fork anchors. */
function forkEntries(conversation: ConversationView): string[] {
  const entries: string[] = [];
  let lastAssistant: string | undefined;
  for (const entry of conversation.entries) {
    if (entry.kind === "pi.user") {
      if (lastAssistant !== undefined) entries.push(lastAssistant);
      lastAssistant = undefined;
    } else if (entry.kind === "pi.assistant") {
      lastAssistant = String(entry.id);
    }
  }
  if (lastAssistant !== undefined) entries.push(lastAssistant);
  return entries;
}

type ForkFixture = { id: ConversationId; entry: string; title: string };

function withForkSummaries(view: DurableView, forks: readonly ForkFixture[]): DurableView {
  const replace = (node: ConversationNode): ConversationNode => {
    const children = node.children.map(replace);
    if (node.summary.id !== PARSER_ID) return { ...node, children };
    return {
      ...node,
      children: [
        ...children.filter((child) => child.summary.kind !== "fork"),
        ...forks.map((fork) => ({
          summary: {
            id: fork.id,
            kind: "fork" as const,
            parent: PARSER_ID,
            forkedAt: fork.entry,
            title: fork.title,
            updatedAt: Date.now(),
          },
          children: [],
        })),
      ],
    };
  };
  const organized: Organized = {
    ...view.organized,
    chats: view.organized.chats.map(replace),
    projects: view.organized.projects.map((project) => ({
      ...project,
      conversations: project.conversations.map(replace),
    })),
    archived: view.organized.archived.map((entry) => ({ ...entry, node: replace(entry.node) })),
  };
  return { ...view, organized };
}

function parentView(): DurableView {
  const base = fakeView({ conversation: twoRunParent() });
  return withForkSummaries(base, []);
}

function forkSide(id: ConversationId, entry: string): ConversationView {
  const base = forkConversation();
  return {
    ...base,
    conversation: { id, parent: { conversationId: PARSER_ID, at: Number(entry) } },
  } as unknown as ConversationView;
}

function withSide(view: DurableView, id: ConversationId, entry: string): DurableView {
  return { ...view, side: { id, conversation: forkSide(id, entry), docs: [] } };
}

function withTaskSide(view: DurableView): DurableView {
  return { ...view, side: { id: SUBAGENT_ID, conversation: subagentConversation(), docs: [] } };
}

function renderStandalone(
  remote: RemoteDurable,
  focusConversation: (ref: { hostKey: string; conversationId?: ConversationId }) => void = vi.fn(),
) {
  const hosts = {
    ...fakeHosts([HOME_HOST], HOME_HOST.hostKey),
    focus: { hostKey: HOME_HOST.hostKey },
    focusConversation,
  };
  return render(
    <HostsContext.Provider value={hosts}>
      <Workbench remote={remote} wsUrl="ws://test" hostKey={HOME_HOST.hostKey} notify={false} />
    </HostsContext.Provider>,
  );
}

async function forkFromRun(user: ReturnType<typeof userEvent.setup>, index = 0) {
  const actions = screen.getAllByRole("button", { name: "Fork" });
  await user.click(actions[index]!);
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
          renderWorkbench={({ host, remote, opening, cancelOpening, openConversation }) => (
            <Workbench
              remote={remote}
              wsUrl={host.url}
              hostKey={host.hostKey}
              framed={false}
              notify={false}
              hostOpening={opening}
              hostOpen={openConversation}
              hostCancelOpening={cancelOpening}
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
) {
  return render(
    <FocusHarness
      hosts={[HOME_HOST, DEVBOX_HOST]}
      remotes={remotes}
      initialFocus={{ hostKey: HOME_HOST.hostKey, conversationId: PARSER_ID }}
      onFocus={onFocus}
      setFocusRef={setFocusRef}
    />,
  );
}

describe("fork handoff through the invisible side", () => {
  it("keeps main on the parent until the summary matches, then returns without stealing focus", async () => {
    const user = userEvent.setup();
    const base = parentView();
    const [entry] = forkEntries(base.conversation!);
    const { remote, publish } = mutableRemote(base);
    const { remote: remoteB } = mutableRemote();
    let releaseSummary!: () => void;
    const summaryGate = new Promise<void>((resolve) => {
      releaseSummary = resolve;
    });
    let releaseSubmit!: () => void;
    const submitGate = new Promise<void>((resolve) => {
      releaseSubmit = resolve;
    });
    remote.controller.fork = vi.fn(async (forkEntry: string) => {
      publish(withSide(withForkSummaries(base, []), FORK_ID, forkEntry));
      await summaryGate;
      publish(withSide(withForkSummaries(base, [{ id: FORK_ID, entry: forkEntry, title: "fork one" }]), FORK_ID, forkEntry));
      await submitGate;
    });
    remote.controller.switchConversation = vi.fn(async (id: ConversationId) => {
      publish(
        id === FORK_ID
          ? {
              ...withForkSummaries(base, [{ id: FORK_ID, entry: entry!, title: "fork one" }]),
              conversation: forkSide(FORK_ID, entry!),
              side: undefined,
            }
          : withForkSummaries(base, [{ id: FORK_ID, entry: entry!, title: "fork one" }]),
      );
    });
    const onFocus = vi.fn();
    const setFocus = { current: (_focus: HostFocus) => {} };
    renderHarness(new Map([[HOME_HOST.hostKey, remote], [DEVBOX_HOST.hostKey, remoteB]]), onFocus, setFocus);
    await screen.findAllByRole("button", { name: "Fork" });
    expect(entry).toBeDefined();
    await forkFromRun(user);

    // The side snapshot arrived, but organized has not named the fork yet.
    await waitFor(() => expect(remote.view.current().side?.id).toBe(FORK_ID));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Fix the parser's trailing-comma bug");
    expect(onFocus).not.toHaveBeenCalled();
    expect(remote.controller.switchConversation).not.toHaveBeenCalledWith(FORK_ID);

    await act(async () => releaseSummary());
    await waitFor(() =>
      expect(onFocus).toHaveBeenCalledWith({ hostKey: HOME_HOST.hostKey, conversationId: FORK_ID }),
    );

    // The reader returns to the parent before the first submit settles.
    act(() => {
      setFocus.current({ hostKey: HOME_HOST.hostKey, conversationId: PARSER_ID });
      publish(withForkSummaries(base, [{ id: FORK_ID, entry: entry!, title: "fork one" }]));
    });
    await act(async () => releaseSubmit());
    await waitFor(() => expect(screen.getByRole("button", { name: "Fork" })).not.toBeDisabled());
    expect(onFocus).toHaveBeenCalledTimes(1);
    expect(onFocus).toHaveBeenCalledWith({ hostKey: HOME_HOST.hostKey, conversationId: FORK_ID });
  });

  it("does not accept fork1 after A creates fork2, and only opens fork2", async () => {
    const user = userEvent.setup();
    const base = parentView();
    const [entry1, entry2] = forkEntries(base.conversation!);
    const { remote, publish, current } = mutableRemote(base);
    const { remote: remoteB } = mutableRemote();
    let releaseFork1Summary!: () => void;
    const fork1Summary = new Promise<void>((resolve) => {
      releaseFork1Summary = resolve;
    });
    let releaseFork2Summary!: () => void;
    const fork2Summary = new Promise<void>((resolve) => {
      releaseFork2Summary = resolve;
    });
    let call = 0;
    remote.controller.fork = vi.fn(async (forkEntry: string) => {
      call += 1;
      if (call === 1) {
        publish(withSide(withForkSummaries(base, []), FORK_ID, forkEntry));
        await fork1Summary;
        publish(withForkSummaries(current(), [{ id: FORK_ID, entry: forkEntry, title: "fork one" }]));
        return;
      }
      publish(withSide(withForkSummaries(base, []), SECOND_FORK_ID, forkEntry));
      await fork2Summary;
      publish(
        withSide(
          withForkSummaries(base, [
            { id: FORK_ID, entry: entry1!, title: "fork one" },
            { id: SECOND_FORK_ID, entry: forkEntry, title: "fork two" },
          ]),
          SECOND_FORK_ID,
          forkEntry,
        ),
      );
    });
    remote.controller.switchConversation = vi.fn(async (id: ConversationId) => {
      if (id === SECOND_FORK_ID) {
        publish({
          ...withForkSummaries(base, [
            { id: FORK_ID, entry: entry1!, title: "fork one" },
            { id: SECOND_FORK_ID, entry: entry2!, title: "fork two" },
          ]),
          conversation: forkSide(SECOND_FORK_ID, entry2!),
          side: undefined,
        });
      } else {
        publish(withForkSummaries(base, []));
      }
    });
    const onFocus = vi.fn();
    const setFocus = { current: (_focus: HostFocus) => {} };
    renderHarness(new Map([[HOME_HOST.hostKey, remote], [DEVBOX_HOST.hostKey, remoteB]]), onFocus, setFocus);

    await screen.findAllByRole("button", { name: "Fork" });
    expect(entry1).toBeDefined();
    expect(entry2).toBeDefined();
    await forkFromRun(user, 0);
    await waitFor(() => expect(remote.view.current().side?.id).toBe(FORK_ID));

    // A leaves; the workbench for A unmounts while fork1's command is pending.
    act(() => setFocus.current({ hostKey: DEVBOX_HOST.hostKey, conversationId: PARSER_ID }));
    await waitFor(() => expect(remote.controller.clearConversation).toHaveBeenCalled());

    // Back on A, create fork2 from the other run.
    act(() => setFocus.current({ hostKey: HOME_HOST.hostKey, conversationId: PARSER_ID }));
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Fork" })).toHaveLength(2));
    await forkFromRun(user, 1);
    await waitFor(() => expect(remote.view.current().side?.id).toBe(SECOND_FORK_ID));

    // fork1's summary is late and must not be mistaken for fork2.
    await act(async () => releaseFork1Summary());
    await waitFor(() =>
      expect(
        remote.view.current().organized.projects.some((project) =>
          project.conversations.some((node) => node.children.some((child) => child.summary.id === FORK_ID)),
        ),
      ).toBe(true),
    );
    expect(onFocus).not.toHaveBeenCalledWith({ hostKey: HOME_HOST.hostKey, conversationId: FORK_ID });

    await act(async () => releaseFork2Summary());
    await waitFor(() =>
      expect(onFocus).toHaveBeenCalledWith({ hostKey: HOME_HOST.hostKey, conversationId: SECOND_FORK_ID }),
    );
    expect(onFocus).not.toHaveBeenCalledWith({ hostKey: HOME_HOST.hostKey, conversationId: FORK_ID });
  });
});

describe("fork command settlement", () => {
  it("recovers busy when a command resolves without staging a side, and allows a retry", async () => {
    const user = userEvent.setup();
    const base = parentView();
    const { remote } = mutableRemote(base);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    remote.controller.fork = vi.fn(async () => {
      await gate;
    });
    const focusConversation = vi.fn();
    renderStandalone(remote, focusConversation);

    await screen.findAllByRole("button", { name: "Fork" });
    await forkFromRun(user);
    const action = screen.getAllByRole("button", { name: "Fork" })[0]!;
    await waitFor(() => expect(action).toBeDisabled());
    await user.click(action);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(remote.controller.fork).toHaveBeenCalledTimes(1);

    await act(async () => release());
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Fork" })[0]).not.toBeDisabled());
    expect(focusConversation).not.toHaveBeenCalled();

    // A retry uses the same entry after the failed handoff released the lock.
    await forkFromRun(user);
    expect(remote.controller.fork).toHaveBeenCalledTimes(2);
  });

  it("opens the fork through a single connection that has hostKey but no hostOpen", async () => {
    const user = userEvent.setup();
    const base = parentView();
    const [entry] = forkEntries(base.conversation!);
    const { remote, publish } = mutableRemote(base);
    remote.controller.fork = vi.fn(async (forkEntry: string) => {
      publish(
        withSide(
          withForkSummaries(base, [{ id: FORK_ID, entry: forkEntry, title: "fork one" }]),
          FORK_ID,
          forkEntry,
        ),
      );
    });
    remote.controller.switchConversation = vi.fn(async (id: ConversationId) => {
      if (id !== FORK_ID) return;
      publish({
        ...withForkSummaries(base, [{ id: FORK_ID, entry: entry!, title: "fork one" }]),
        conversation: forkSide(FORK_ID, entry!),
        side: undefined,
      });
    });
    const focusConversation = vi.fn();
    renderStandalone(remote, focusConversation);

    await screen.findAllByRole("button", { name: "Fork" });
    await forkFromRun(user);

    await waitFor(() => expect(remote.controller.switchConversation).toHaveBeenCalledWith(FORK_ID));
    expect(focusConversation).not.toHaveBeenCalled();
    await waitFor(() => expect(remote.controller.showSide).toHaveBeenCalledWith(undefined));

    // Back on the parent, the handoff lock is gone.
    act(() => publish(withForkSummaries(base, [{ id: FORK_ID, entry: entry!, title: "fork one" }])));
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Fork" })[0]).not.toBeDisabled());
  });

  it("leaves another Task side open instead of clearing it", async () => {
    const user = userEvent.setup();
    const base = parentView();
    const [entry] = forkEntries(base.conversation!);
    const { remote, publish } = mutableRemote(base);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    remote.controller.fork = vi.fn(async (forkEntry: string) => {
      publish(withSide(withForkSummaries(base, []), FORK_ID, forkEntry));
      await gate;
    });
    renderStandalone(remote);

    await screen.findAllByRole("button", { name: "Fork" });
    await forkFromRun(user);
    await waitFor(() => expect(remote.view.current().side?.id).toBe(FORK_ID));

    // The reader opens a Task detail beside the pending stage.
    act(() => publish(withTaskSide(base)));
    const showSide = vi.fn(async () => {});
    remote.controller.showSide = showSide;
    await act(async () => release());

    await waitFor(() => expect(screen.getAllByRole("button", { name: "Fork" })[0]).not.toBeDisabled());
    expect(remote.view.current().side?.id).toBe(SUBAGENT_ID);
    expect(showSide).not.toHaveBeenCalledWith(undefined);
  });
});
