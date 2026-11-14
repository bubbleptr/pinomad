// "New host X joined your account", once per device per host (#496): a host
// confirmed anywhere pairs here on its own, so this is where the user learns
// a machine they didn't add got in.
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountHostMatch } from "@pinomad/client/account.ts";
import { AccountContext } from "../../entities/account/account-context.tsx";
import type { AccountModel, AccountState } from "../../entities/account/account-model.ts";
import { createKnownHostsStore, type KnownHostsStore } from "../../entities/account/known-hosts.ts";
import { HostsContext } from "../../entities/host/host-store.ts";
import { Toaster } from "../../shared/ui/toast.tsx";
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
        <Toaster>
          <NewHostNotices knownHosts={knownHosts} />
        </Toaster>
      </AccountContext.Provider>
    </HostsContext.Provider>,
  );

const studio = match("s".repeat(43), "studio");
const omarchy = match("o".repeat(43), "omarchy");

const toasts = (text: RegExp): HTMLElement[] => screen.queryAllByText(text);

/** Lets a few frames pass, so the assertions see what a slow CI runner sees. */
const nextFrames = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 50)));

beforeEach(() => localStorage.clear());

describe("NewHostNotices", () => {
  it("says nothing on the first load after sign-in, then announces a later host once", async () => {
    const knownHosts = createKnownHostsStore(localStorage);
    const account = liveAccount({ status: "checking" });
    const { unmount } = renderNotices(account, knownHosts);
    act(() => account.setState(signedIn({ hosts: [studio] })));
    await nextFrames();
    expect(toasts(/joined your account/)).toHaveLength(0);

    act(() => account.setState(signedIn({ hosts: [studio, omarchy] })));
    await nextFrames();
    expect(toasts(/New host omarchy joined your account/)).toHaveLength(1);
    expect(toasts(/New host studio/)).toHaveLength(0);

    // Later refreshes stay quiet about it…
    act(() => account.setState(signedIn({ hosts: [studio, omarchy] })));
    await nextFrames();
    expect(toasts(/New host omarchy joined your account/)).toHaveLength(1);

    // …and so does the next page load.
    unmount();
    renderNotices(liveAccount(signedIn({ hosts: [studio, omarchy] })), knownHosts);
    await nextFrames();
    expect(toasts(/joined your account/)).toHaveLength(0);
  });

  it("doesn't seed from a failed first refresh, which lists no hosts", async () => {
    const knownHosts = createKnownHostsStore(localStorage);
    const account = liveAccount(signedIn({ hosts: [], hostsError: { code: "network" } }));
    renderNotices(account, knownHosts);
    act(() => account.setState(signedIn({ hosts: [studio] })));
    await nextFrames();
    expect(toasts(/joined your account/)).toHaveLength(0);
  });

  it("announces a host that joined while this device was away", async () => {
    const knownHosts = createKnownHostsStore(localStorage);
    knownHosts.arrivals({ serverOrigin: "https://pinomad.si", user: "kieran@example.com" }, [{ hostId: studio.host.hostId }]);
    renderNotices(liveAccount(signedIn({ hosts: [studio, omarchy] })), knownHosts);
    await nextFrames();
    expect(toasts(/New host omarchy joined your account/)).toHaveLength(1);
  });

  it("announces a host again when it is back after a removal (#531)", async () => {
    const knownHosts = createKnownHostsStore(localStorage);
    const joinedAt = (each: AccountHostMatch, at: number): AccountHostMatch => ({ ...each, host: { ...each.host, joinedAt: at } });
    knownHosts.arrivals({ serverOrigin: "https://pinomad.si", user: "kieran@example.com" }, [
      { hostId: studio.host.hostId, joinedAt: 1 },
      { hostId: omarchy.host.hostId, joinedAt: 1 },
    ]);
    renderNotices(liveAccount(signedIn({ hosts: [joinedAt(studio, 1), joinedAt(omarchy, 2)] })), knownHosts);
    await nextFrames();
    expect(toasts(/New host omarchy joined your account/)).toHaveLength(1);
    expect(toasts(/New host studio joined your account/)).toHaveLength(0);
  });

  it("goes straight to removing the new host, with the password again (#512)", async () => {
    const knownHosts = createKnownHostsStore(localStorage);
    knownHosts.arrivals({ serverOrigin: "https://pinomad.si", user: "kieran@example.com" }, [{ hostId: studio.host.hostId }]);
    const account = liveAccount(signedIn({ hosts: [studio, omarchy] }));
    const removeHost = vi.fn(async () => ({ ok: true as const, value: undefined }));
    renderNotices({ ...account, removeHost }, knownHosts);
    await nextFrames();
    expect(toasts(/New host omarchy joined your account/)).toHaveLength(1);
    // The viewport is a manual popover jsdom never shows, so its contents
    // count as hidden to role queries.
    await userEvent.click(screen.getByRole("button", { name: "Remove", hidden: true }));
    await userEvent.type(await screen.findByLabelText("Password"), "my password{Enter}");
    expect(removeHost).toHaveBeenCalledWith({ hostId: omarchy.host.hostId, confirmation: { reauth: "grant" } });
    await vi.waitFor(() => expect(screen.queryByLabelText("Password")).toBeNull());
  });
});
