// The main column's Inbox screens (ADR-0051 §6): a project's intake before
// its first message and a task still in the queue. Each gives way to its own
// conversation once the host has one, whoever opened it.
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { HostInbox } from "@pinomad/protocol/inbox.ts";
import type { DurableView } from "@pinomad/protocol/view.ts";
import { Workbench } from "./App.tsx";
import { HostComposerContext } from "./entities/composer/composer-context.tsx";
import { HostComposerStore, newDraftKey, type InboxTarget } from "./entities/composer/composer-store.ts";
import { HostsContext } from "./entities/host/host-store.ts";
import {
  fakeHosts,
  fakeRemote,
  HOME_HOST,
  PINOMAD,
  PINOMAD_INBOX,
  RUNNING_TASK_ID,
  TASK,
  WEBSITE,
  WEBSITE_INBOX,
  withInbox,
} from "./test/story-fixtures.tsx";

/** A remote whose view the test can replace, as a host's stream update would. */
function liveRemote(initial: DurableView) {
  let current = initial;
  const listeners = new Set<() => void>();
  const remote = {
    ...fakeRemote(initial),
    view: {
      current: () => current,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  } as ReturnType<typeof fakeRemote>;
  const push = (next: DurableView): void => {
    current = next;
    act(() => {
      for (const listener of listeners) listener();
    });
  };
  return { remote, push };
}

function renderOn(target: InboxTarget | undefined, view: DurableView, conversationId?: ConversationId) {
  const store = new HostComposerStore();
  if (target !== undefined) store.slot(newDraftKey).setInbox(target);
  const hosts = { ...fakeHosts([HOME_HOST], HOME_HOST.hostKey), focus: { hostKey: HOME_HOST.hostKey, conversationId } };
  const { remote, push } = liveRemote(view);
  render(
    <HostsContext.Provider value={hosts}>
      <HostComposerContext.Provider value={store}>
        <Workbench remote={remote} wsUrl="ws://test" hostKey={HOME_HOST.hostKey} framed={false} notify={false} hostOpen={vi.fn()} />
      </HostComposerContext.Provider>
    </HostsContext.Provider>,
  );
  return { hosts, remote, push, store };
}

const inboxWith = (patch: (inbox: HostInbox) => HostInbox) => withInbox(undefined, patch({ inboxes: [PINOMAD_INBOX, WEBSITE_INBOX] }));

afterEach(() => window.localStorage.clear());

describe("Inbox screens in main", () => {
  it("opens the intake once the host has it", () => {
    const view = withInbox();
    const { hosts, push } = renderOn({ project: WEBSITE.path }, view);
    expect(screen.getByText("Tell the Inbox what needs doing")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("website");

    push(inboxWith(({ inboxes }) => ({ inboxes: inboxes.map((each) => (each.project === WEBSITE.path ? { ...each, intake: 90 as ConversationId } : each)) })));
    expect(hosts.focusConversation).toHaveBeenCalledWith({ hostKey: HOME_HOST.hostKey, conversationId: 90 });
  });

  it("opens a queued task's conversation once the worker takes it", () => {
    const { hosts, push } = renderOn({ project: PINOMAD.path, task: TASK.queued }, withInbox());
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("CSV export garbles Chinese text");

    push(
      inboxWith(({ inboxes }) => ({
        inboxes: inboxes.map((each) => ({
          ...each,
          tasks: each.tasks.map((task) => (task.id === TASK.queued ? { ...task, conversationId: 91 as ConversationId, inFlight: true as const } : task)),
        })),
      })),
    );
    expect(hosts.focusConversation).toHaveBeenCalledWith({ hostKey: HOME_HOST.hostKey, conversationId: 91 });
  });

  it("keeps Tasks on an Inbox screen, with that Inbox's rules", async () => {
    renderOn({ project: PINOMAD.path, task: TASK.queued }, withInbox());
    expect(screen.queryByRole("button", { name: "Changes" })).toBeNull();
    await userEvent.setup().click(screen.getByRole("button", { name: "Tasks" }));
    const panel = screen.getByRole("complementary", { name: "Side panel" });
    expect(within(panel).getByText(PINOMAD_INBOX.rules)).toBeInTheDocument();
  });

  it("titles a task's conversation by its task, not the worker's first message", () => {
    renderOn(undefined, withInbox(undefined), RUNNING_TASK_ID);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Avatar sometimes missing after sign-in");
  });
});
