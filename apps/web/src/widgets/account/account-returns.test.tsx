// What finishes after the user moved on: a provider link that came back
// while the panel opened on another page, and an email save that lands after
// its dialog was closed and opened again (dureview #642).
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AccountContext } from "../../entities/account/account-context.tsx";
import type { AccountModel } from "../../entities/account/account-model.ts";
import { HostsContext } from "../../entities/host/host-store.ts";
import { fakeAccount, fakeHosts, signedIn } from "../../test/story-fixtures.tsx";
import { AccountEmail } from "./account-email.tsx";
import { AccountPanel } from "./account-panel.tsx";

vi.mock("../../entities/account/oauth-return.ts", () => ({
  oauthReturn: () => ({ linked: "google" }),
  clearOAuthReturn: vi.fn(),
}));

describe("after the user moved on", () => {
  it("says how a provider link went on the account's hosts page too", async () => {
    render(
      <HostsContext.Provider value={fakeHosts([])}>
        <AccountContext.Provider value={fakeAccount(signedIn())}>
          <AccountPanel initialPage="hosts" />
        </AccountContext.Provider>
      </HostsContext.Provider>,
    );
    expect(await screen.findByText("Google linked")).toBeTruthy();
  });

  it("ignores an email save that lands after its dialog was closed and opened again", async () => {
    let finish!: () => void;
    const account: AccountModel = {
      ...fakeAccount(signedIn({ email: "old@example.com" })),
      identities: vi.fn(() => Promise.resolve({ ok: true as const, value: { hasPassword: false, identities: [] } })),
      reauth: vi.fn(() => Promise.resolve({ ok: true as const, value: { reauth: "grant", expiresAt: Date.now() + 300_000 } })),
      setEmail: vi.fn<AccountModel["setEmail"]>(
        () => new Promise((resolve) => (finish = () => resolve({ ok: true, value: undefined }))),
      ),
    };
    render(<AccountEmail account={account} email="old@example.com" />);
    await userEvent.click(screen.getByRole("button", { name: "Change email" }));
    await userEvent.type(await screen.findByLabelText("Email"), "new@example.com");
    await userEvent.click(await screen.findByRole("button", { name: "Send code" }));
    await userEvent.type(await screen.findByLabelText("Confirmation code"), "111111");
    await userEvent.click(screen.getByRole("button", { name: "Send code to new email" }));
    await userEvent.type(await screen.findByLabelText("Code"), "222222");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    // Closed while saving, then opened again and half filled in.
    await userEvent.click(within(screen.getByRole("dialog", { name: "Change email" })).getByRole("button", { name: /close/i }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Change email" }));
    await userEvent.type(await screen.findByLabelText("Email"), "half@example.com");

    await act(async () => finish());
    expect(screen.getByRole("dialog", { name: "Change email" })).toBeTruthy();
    expect((screen.getByLabelText("Email") as HTMLInputElement).value).toBe("half@example.com");
    expect(screen.queryByText("Email saved.")).toBeNull();
  });
});
