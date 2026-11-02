import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { DurableView } from "@pinomad/protocol/view.ts";
import { Workbench } from "./App.tsx";
import { HostsContext } from "./entities/host/host-store.ts";
import { fakeHosts, fakeRemote, fakeView, FORK_ID, forkConversation, HOME_HOST, PARSER_ID } from "./test/story-fixtures.tsx";

/** A view whose snapshot changes when the controller reports a new conversation. */
function mutableRemote(onFork?: () => Promise<void>) {
  let current: DurableView = fakeView();
  const listeners = new Set<() => void>();
  const base = fakeRemote(current);
  const publish = (next: DurableView): void => {
    current = next;
    for (const listener of listeners) listener();
  };
  const remote = {
    ...base,
    view: {
      current: () => current,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    controller: {
      ...base.controller,
      fork: vi.fn(async () => {
        await onFork?.();
        publish(fakeView({ conversation: forkConversation() }));
      }),
    },
  } as typeof base;
  return { remote, publish };
}

function renderWorkbench(remote: ReturnType<typeof mutableRemote>["remote"], focusConversation: (ref: { hostKey: string; conversationId?: ConversationId }) => void, conversationId: ConversationId = PARSER_ID) {
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

describe("creating a fork", () => {
  it("focuses the new fork in main instead of opening a panel", async () => {
    const user = userEvent.setup();
    const { remote } = mutableRemote();
    const focusConversation = vi.fn();
    renderWorkbench(remote, focusConversation);

    await forkFromFirstRun(user);

    await waitFor(() =>
      expect(focusConversation).toHaveBeenCalledWith({ hostKey: HOME_HOST.hostKey, conversationId: FORK_ID }),
    );
    // The fork is the main target; no side panel is opened for it.
    expect(screen.queryByRole("complementary", { name: "Side panel" })).toBeNull();
  });

  it("does not steal focus when the reader moved while the fork was being created", async () => {
    const user = userEvent.setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { remote } = mutableRemote(() => gate);
    const focusConversation = vi.fn();
    const { rerender } = renderWorkbench(remote, focusConversation);
    const hosts = {
      ...fakeHosts([HOME_HOST], HOME_HOST.hostKey),
      focus: { hostKey: HOME_HOST.hostKey, conversationId: PARSER_ID },
      focusConversation,
    };

    await forkFromFirstRun(user);

    // The reader picks another conversation before the fork lands.
    rerender(
      <HostsContext.Provider
        value={{ ...hosts, focus: { hostKey: HOME_HOST.hostKey, conversationId: 3 as ConversationId } }}
      >
        <Workbench remote={remote} wsUrl="ws://test" hostKey={HOME_HOST.hostKey} framed={false} notify={false} />
      </HostsContext.Provider>,
    );
    release();

    // The reader's conversation 3 wins; the workbench never focuses the fork.
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Explain Rust's borrow checker"),
    );
    expect(focusConversation).not.toHaveBeenCalled();
  });
});
