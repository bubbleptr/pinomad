// A draft that becomes a conversation is the only thing that updates the
// global New chat's host preference (ADR-0035 §7).
import { ToastViewport } from "@astryxdesign/core/Toast";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import { Workbench } from "./App.tsx";
import { LAST_NEW_HOST_KEY } from "./entities/host/last-new-host.ts";
import { HostsContext } from "./entities/host/host-store.ts";
import { fakeHosts, fakeRemote, fakeView, HOME_HOST } from "./test/story-fixtures.tsx";

beforeEach(() => localStorage.clear());

describe("Workbench draft create", () => {
  it("writes the host that created the draft's conversation", async () => {
    const empty = fakeView({ conversation: undefined, home: undefined, checkout: undefined, docs: [] });
    let current = empty;
    const base = fakeRemote(empty, {
      createConversation: vi.fn(async () => {
        const created = fakeView();
        current = { ...created, conversation: { ...created.conversation!, conversation: { id: 99 } } } as never;
      }),
    });
    const remote = {
      ...base,
      view: { current: () => current, subscribe: () => () => {} },
    } as RemoteDurable;
    const state = fakeHosts([HOME_HOST], HOME_HOST.hostKey);
    render(
      <HostsContext.Provider value={state}>
        <ToastViewport position="topEnd" isTopLayer>
          <Workbench
            remote={remote}
            wsUrl={HOME_HOST.url}
            hostKey={HOME_HOST.hostKey}
            notify={false}
            framed={false}
          />
        </ToastViewport>
      </HostsContext.Provider>,
    );

    const editable = document.querySelector<HTMLElement>('[aria-multiline="true"]')!;
    editable.textContent = "first conversation";
    fireEvent.input(editable);
    fireEvent.keyDown(editable, { key: "Enter" });

    await waitFor(() => expect(localStorage.getItem(LAST_NEW_HOST_KEY)).toBe(HOME_HOST.hostKey));
  });
});
