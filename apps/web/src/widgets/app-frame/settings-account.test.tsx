// jsdom: the account inside Settings. Signed in it is one page in groups
// (email, sign-in methods, devices, hosts, danger zone); signed out it is the
// sign-in form; where this client has no account API it isn't there at all.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AccountContext } from "../../entities/account/account-context.tsx";
import type { AccountModel, AccountState } from "../../entities/account/account-model.ts";
import { HostsContext } from "../../entities/host/host-store.ts";
import { fakeAccount, fakeHosts, fakeMachines, HOME_HOST, signedIn } from "../../test/story-fixtures.tsx";
import { SettingsDialog, type SectionId } from "./settings-dialog.tsx";

function renderSettings(state: AccountState, initialSection?: SectionId, actions: Partial<AccountModel> = {}) {
  const account = { ...fakeAccount(state), ...actions };
  render(
    <HostsContext.Provider value={fakeHosts()}>
      <AccountContext.Provider value={account}>
        <SettingsDialog
          machines={fakeMachines()}
          initialKey={HOME_HOST.hostKey}
          {...(initialSection === undefined ? {} : { initialSection })}
          onClose={vi.fn()}
        />
      </AccountContext.Provider>
    </HostsContext.Provider>,
  );
  return account;
}

const nav = () => screen.getByRole("navigation", { name: "Settings sections" });

describe("Settings → Account", () => {
  it("opens on the account when asked to, everything on one page", async () => {
    renderSettings(signedIn(), "account");
    expect(await screen.findByRole("heading", { name: "Account" })).toBeTruthy();
    expect(screen.getByText("kieran@example.com", { selector: "h3, [role=heading]" })).toBeTruthy();
    for (const group of ["Email", "Sign-in methods", "Signed-in devices", "Danger zone"]) {
      expect(await screen.findByRole("heading", { name: group })).toBeTruthy();
    }
  });

  it("has no account group where this client can't reach an account", () => {
    renderSettings({ status: "unavailable" });
    expect(within(nav()).queryByRole("button", { name: "Account" })).toBeNull();
  });

  it("offers only the sign-in form while signed out", async () => {
    renderSettings({ status: "signed-out", mode: "cookie" }, "account");
    expect(within(nav()).getByRole("button", { name: "Account" })).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeTruthy();
  });

  it("signs out from the account page after the dialog confirms", async () => {
    const account = renderSettings(signedIn(), "account");
    await userEvent.click(await screen.findByRole("button", { name: "Sign out…" }));
    const dialog = screen.getByRole("dialog", { name: "Sign out of pinomad.si?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Sign out" }));
    expect(account.logout).toHaveBeenCalledWith({ revoke: false });
  });
});
