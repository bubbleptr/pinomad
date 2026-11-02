// The page `pinomad join <origin>` opens: <origin>/host-link, with no code in
// it. App shows the code entry over whatever screen is underneath, after a
// sign-in when there is no session, and puts the address back to / after.
// With ?request=<id> (#513) it confirms that host instead and sends the
// browser back to it.
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountResult } from "@pinomad/client/account.ts";
import { AccountContext } from "../../entities/account/account-context.tsx";
import type { AccountModel, AccountState } from "../../entities/account/account-model.ts";
import { HostsContext } from "../../entities/host/host-store.ts";
import { fakeAccount, fakeHosts, signedIn } from "../../test/story-fixtures.tsx";
import { HostLinkRoute } from "./host-link-route.tsx";

const REDIRECT = "http://127.0.0.1:54321/callback";
const REQUEST_ID = "r".repeat(43);

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
    confirmHostLink: vi.fn(() => ok(undefined)),
    lookupHostLinkRequest: vi.fn(() =>
      ok({ hostId: "h".repeat(43), name: "e2e-mbp", os: "macOS", sourceIp: "203.0.113.7", ipDiffers: false, expiresAt: Date.now() + 60_000 }),
    ),
    confirmHostLinkRequest: vi.fn(() => ok(`${REDIRECT}?code=c&state=s`)),
    denyHostLinkRequest: vi.fn(() => ok(`${REDIRECT}?error=access_denied&state=s`)),
    watchForHost: vi.fn(),
  };
}

const renderRoute = (account: AccountModel, navigate: (url: string) => void = vi.fn()) =>
  render(
    <HostsContext.Provider value={fakeHosts([], null)}>
      <AccountContext.Provider value={account}>
        <HostLinkRoute navigate={navigate} />
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

  it("hands the wait for the host to the model, so closing the dialog with Done doesn't end it", async () => {
    window.history.replaceState(null, "", "/host-link");
    const account = liveAccount(signedIn());
    renderRoute(account);
    const user = userEvent.setup();
    await user.type(codeInput()!, "KXHNBWCV");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(await screen.findByRole("button", { name: "Confirm" }));
    await user.click(await screen.findByRole("button", { name: "Done" }));
    expect(codeInput()).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    // The model owns the 5 s / 2 min refresh (account-model.test.ts); nothing here can cancel it.
    expect(account.watchForHost).toHaveBeenCalledTimes(1);
    expect(account.watchForHost).toHaveBeenCalledWith("h".repeat(43));
  });

  describe("with ?request= from a host on this computer (#513)", () => {
    it("signs in first, looks the host up by itself, and sends the confirmation back through the browser", async () => {
      window.history.replaceState(null, "", `/host-link?request=${REQUEST_ID}`);
      const account = liveAccount({ status: "signed-out", mode: "cookie" });
      const navigate = vi.fn();
      renderRoute(account, navigate);
      expect(screen.getByText(/to confirm it/)).toBeInTheDocument();
      // A sign-in that rewrote the address would lose nothing: the id was read at the start.
      window.history.replaceState(null, "", "/host-link");
      act(() => account.setState(signedIn()));

      await userEvent.setup().click(await screen.findByRole("button", { name: "Confirm" }));
      expect(account.lookupHostLinkRequest).toHaveBeenCalledWith(REQUEST_ID);
      expect(account.confirmHostLinkRequest).toHaveBeenCalledWith(REQUEST_ID);
      expect(navigate).toHaveBeenCalledWith(`${REDIRECT}?code=c&state=s`);
      expect(account.watchForHost).toHaveBeenCalledWith("h".repeat(43));
      expect(window.location.pathname).toBe("/");
      // Nothing to type, and no way back to a code field.
      expect(codeInput()).toBeNull();
      expect(screen.queryByRole("button", { name: "Enter another code" })).toBeNull();
    });

    it("sends a denial back to the host too, so its terminal stops waiting", async () => {
      window.history.replaceState(null, "", `/host-link?request=${REQUEST_ID}`);
      const account = liveAccount(signedIn());
      const navigate = vi.fn();
      renderRoute(account, navigate);
      await userEvent.setup().click(await screen.findByRole("button", { name: "Deny" }));
      expect(navigate).toHaveBeenCalledWith(`${REDIRECT}?error=access_denied&state=s`);
      expect(account.watchForHost).not.toHaveBeenCalled();
    });

    it("says the host is gone when the request is, and goes nowhere", async () => {
      window.history.replaceState(null, "", `/host-link?request=${REQUEST_ID}`);
      const account = liveAccount(signedIn());
      vi.mocked(account.lookupHostLinkRequest).mockReturnValue(
        Promise.resolve({ ok: false, error: { code: "not_found", status: 404 } }),
      );
      const navigate = vi.fn();
      renderRoute(account, navigate);
      expect(await screen.findByText("Couldn't find this host")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
      expect(navigate).not.toHaveBeenCalled();
    });

    it("treats an id that can't be one as no id: the code entry", () => {
      window.history.replaceState(null, "", "/host-link?request=..%2Fx");
      const account = liveAccount(signedIn());
      renderRoute(account);
      expect(codeInput()).toBeInTheDocument();
      expect(account.lookupHostLinkRequest).not.toHaveBeenCalled();
    });
  });
});
