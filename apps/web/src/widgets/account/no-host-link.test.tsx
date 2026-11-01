// The no-host landing keeps asking the account for hosts until one is paired
// here: a host that joined while offline only pairs on a later refresh.
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountHostMatch } from "@pinomad/client/account.ts";
import { AccountContext } from "../../entities/account/account-context.tsx";
import type { AccountModel, AccountState } from "../../entities/account/account-model.ts";
import { HostsContext } from "../../entities/host/host-store.ts";
import { fakeAccount, fakeHosts, signedIn } from "../../test/story-fixtures.tsx";
import { HOST_REFRESH_MS, NoHostLink } from "./no-host-link.tsx";

const offlineHost: AccountHostMatch = {
  host: {
    hostId: "h".repeat(43),
    name: "studio",
    noisePublicKey: "A".repeat(43),
    online: false,
    lastSeenAt: Date.now(),
    pairing: "offline",
  },
  status: "unpaired",
  linkable: false,
  autoRegister: true,
};

function liveAccount(initial: AccountState): AccountModel & { setState(next: AccountState): void } {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    ...fakeAccount(initial),
    get state() {
      return state;
    },
    setState(next: AccountState) {
      state = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refreshHosts: vi.fn(async () => ({ ok: true as const, value: [] })),
  };
}

const renderLanding = (account: AccountModel) =>
  render(
    <HostsContext.Provider value={fakeHosts([], null)}>
      <AccountContext.Provider value={account}>
        <NoHostLink />
      </AccountContext.Provider>
    </HostsContext.Provider>,
  );

describe("NoHostLink", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps refreshing after a host joins offline, past the first-host home", async () => {
    const account = liveAccount(signedIn({ hosts: [] }));
    renderLanding(account);
    expect(await screen.findByRole("heading", { name: "Add your first host" })).toBeTruthy();

    // The host joined but isn't online yet: the panel lists it, unpaired.
    act(() => account.setState(signedIn({ hosts: [offlineHost] })));
    expect(screen.queryByRole("heading", { name: "Add your first host" })).toBeNull();
    expect(await screen.findByText("studio")).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(HOST_REFRESH_MS * 2);
    });
    expect(account.refreshHosts).toHaveBeenCalledTimes(2);
  });

  it("leads with the command without a token and the code entry; a token waits for Advanced (#496)", async () => {
    const account = liveAccount(signedIn({ hosts: [] }));
    renderLanding(account);
    expect(await screen.findByText("npm i -g pinomad && pinomad join https://pinomad.si")).toBeTruthy();
    expect(screen.getByRole("textbox", { name: /code/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Have a pairing link?" })).toBeTruthy();
    expect(account.createJoinToken).not.toHaveBeenCalled();
  });

  it("doesn't poll while signed out", async () => {
    const account = liveAccount({ status: "signed-out", mode: "cookie" });
    renderLanding(account);
    await act(async () => {
      vi.advanceTimersByTime(HOST_REFRESH_MS * 2);
    });
    expect(account.refreshHosts).not.toHaveBeenCalled();
  });
});
