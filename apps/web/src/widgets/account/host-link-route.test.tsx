// The page `pinomad join <origin>` opens: <origin>/host-link, with no code in
// it. App shows the code entry over whatever screen is underneath, after a
// sign-in when there is no session, and puts the address back to / after.
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountResult } from "@pinomad/client/account.ts";
import { AccountContext } from "../../entities/account/account-context.tsx";
import type { AccountModel, AccountState } from "../../entities/account/account-model.ts";
import { HostsContext } from "../../entities/host/host-store.ts";
import { fakeAccount, fakeHosts, signedIn } from "../../test/story-fixtures.tsx";
import { HostLinkRoute } from "./host-link-route.tsx";

const ok = <T,>(value: T): Promise<AccountResult<T>> => Promise.resolve({ ok: true, value });

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
    lookupHostLink: vi.fn(() =>
      ok({ hostId: "h".repeat(43), name: "e2e-mbp", os: "Linux", sourceIp: "203.0.113.7", ipDiffers: false, expiresAt: Date.now() + 60_000 }),
    ),
    denyHostLink: vi.fn(() => ok(undefined)),
  };
}

const renderRoute = (account: AccountModel) =>
  render(
    <HostsContext.Provider value={fakeHosts([], null)}>
      <AccountContext.Provider value={account}>
        <HostLinkRoute />
      </AccountContext.Provider>
    </HostsContext.Provider>,
  );

const codeInput = () => screen.queryByRole("textbox", { name: /code/i });

afterEach(() => window.history.replaceState(null, "", "/"));

describe("HostLinkRoute", () => {
  it("opens the code entry at /host-link", () => {
    window.history.replaceState(null, "", "/host-link");
    renderRoute(liveAccount(signedIn()));
    expect(codeInput()).toBeInTheDocument();
  });

  it("stays closed anywhere else, including a path that tries to carry a code", () => {
    window.history.replaceState(null, "", "/");
    const { unmount } = renderRoute(liveAccount(signedIn()));
    expect(codeInput()).toBeNull();
    unmount();
    window.history.replaceState(null, "", "/host-link/KXHN-BWCV");
    renderRoute(liveAccount(signedIn()));
    expect(codeInput()).toBeNull();
  });

  it("asks for a sign-in first and continues to the entry after it", () => {
    window.history.replaceState(null, "", "/host-link");
    const account = liveAccount({ status: "signed-out", mode: "cookie" });
    renderRoute(account);
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(codeInput()).toBeNull();
    act(() => account.setState(signedIn()));
    expect(codeInput()).toBeInTheDocument();
    expect(window.location.pathname).toBe("/host-link");
  });

  it("puts the address back to / on cancel", async () => {
    window.history.replaceState(null, "", "/host-link");
    renderRoute(liveAccount(signedIn()));
    await userEvent.setup().click(screen.getByRole("button", { name: "Cancel" }));
    expect(window.location.pathname).toBe("/");
    expect(codeInput()).toBeNull();
  });

  it("puts the address back to / once the request is answered, so a reload doesn't reopen it", async () => {
    window.history.replaceState(null, "", "/host-link");
    renderRoute(liveAccount(signedIn()));
    const user = userEvent.setup();
    await user.type(codeInput()!, "KXHNBWCV");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(await screen.findByRole("button", { name: "Deny" }));
    expect(await screen.findByText(/Turned e2e-mbp away/)).toBeInTheDocument();
    expect(window.location.pathname).toBe("/");
  });
});
