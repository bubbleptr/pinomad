// "New host X joined your account", once per device per host (#496): a host
// confirmed anywhere pairs here on its own, so this is where the user learns
// a machine they didn't add got in.
import { ToastViewport } from "@astryxdesign/core/Toast";
import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { AccountHostMatch } from "@pinomad/client/account.ts";
import { AccountContext } from "../../entities/account/account-context.tsx";
import type { AccountModel, AccountState } from "../../entities/account/account-model.ts";
import { createKnownHostsStore, type KnownHostsStore } from "../../entities/account/known-hosts.ts";
import { HostsContext } from "../../entities/host/host-store.ts";
import { fakeAccount, fakeHosts, signedIn } from "../../test/story-fixtures.tsx";
import { NewHostNotices } from "./new-host-notice.tsx";

const match = (hostId: string, name: string): AccountHostMatch => ({
  host: { hostId, name, noisePublicKey: "A".repeat(43), online: true, lastSeenAt: Date.now(), pairing: "available" },
  status: "unpaired",
  linkable: false,
  autoRegister: true,
});

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
  };
}

const renderNotices = (account: AccountModel, knownHosts: KnownHostsStore) =>
  render(
    <HostsContext.Provider value={fakeHosts([], null)}>
      <AccountContext.Provider value={account}>
        <ToastViewport>
          <NewHostNotices knownHosts={knownHosts} />
        </ToastViewport>
      </AccountContext.Provider>
    </HostsContext.Provider>,
  );

const studio = match("s".repeat(43), "studio");
const omarchy = match("o".repeat(43), "omarchy");

beforeEach(() => localStorage.clear());

describe("NewHostNotices", () => {
  it("says nothing on the first load after sign-in, then announces a later host once", async () => {
    const knownHosts = createKnownHostsStore(localStorage);
    const account = liveAccount({ status: "checking" });
    renderNotices(account, knownHosts);
    act(() => account.setState(signedIn({ hosts: [studio] })));
    expect(screen.queryByText(/joined your account/)).toBeNull();

    act(() => account.setState(signedIn({ hosts: [studio, omarchy] })));
    expect(await screen.findByText(/New host omarchy joined your account/)).toBeInTheDocument();
    expect(screen.queryByText(/New host studio/)).toBeNull();

    // Later refreshes, and the next page load, stay quiet about it.
    act(() => account.setState(signedIn({ hosts: [studio, omarchy] })));
    expect(screen.getAllByText(/New host omarchy joined your account/)).toHaveLength(1);
  });

  it("doesn't seed from a failed first refresh, which lists no hosts", async () => {
    const knownHosts = createKnownHostsStore(localStorage);
    const account = liveAccount(signedIn({ hosts: [], hostsError: { code: "network" } }));
    renderNotices(account, knownHosts);
    act(() => account.setState(signedIn({ hosts: [studio] })));
    expect(screen.queryByText(/joined your account/)).toBeNull();
  });

  it("announces a host that joined while this device was away", async () => {
    const knownHosts = createKnownHostsStore(localStorage);
    knownHosts.arrivals({ serverOrigin: "https://pinomad.si", user: "kieran" }, [studio.host.hostId]);
    renderNotices(liveAccount(signedIn({ hosts: [studio, omarchy] })), knownHosts);
    expect(await screen.findByText(/New host omarchy joined your account/)).toBeInTheDocument();
  });
});
