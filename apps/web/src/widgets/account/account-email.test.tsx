// Changing the account's email (ADR-0044 §8) on an account without a
// password: the re-auth grant can lapse between mailing the new address and
// saving it, and the form must let the user confirm again and save.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AccountModel } from "../../entities/account/account-model.ts";
import { fakeAccount, signedIn } from "../../test/story-fixtures.tsx";
import { EmailForm } from "./account-email.tsx";

describe("EmailForm", () => {
  it("asks for the confirmation again when the grant lapsed before saving, keeping the new email's code", async () => {
    let grants = 0;
    let held: { readonly reauth: string } | undefined;
    const account: AccountModel = {
      ...fakeAccount(signedIn({ email: "old@example.com" })),
      identities: vi.fn(() => Promise.resolve({ ok: true as const, value: { hasPassword: false, identities: [] } })),
      reauth: vi.fn(() => {
        held = { reauth: `grant-${++grants}` };
        return Promise.resolve({ ok: true as const, value: { ...held, expiresAt: Date.now() + 300_000 } });
      }),
      recentGrant: () => held,
      forgetGrant: () => {
        held = undefined;
      },
      setEmail: vi
        .fn<AccountModel["setEmail"]>()
        .mockResolvedValueOnce({ ok: false, error: { code: "invalid_reauth", status: 403 } })
        .mockResolvedValueOnce({ ok: true, value: undefined }),
    };
    const onSaved = vi.fn();
    render(<EmailForm account={account} submitLabel="Save" onSaved={onSaved} />);
    await userEvent.type(screen.getByLabelText("Email"), "new@example.com");
    await userEvent.click(await screen.findByRole("button", { name: "Send code" }));
    await userEvent.type(await screen.findByLabelText("Confirmation code"), "111111");
    await userEvent.click(screen.getByRole("button", { name: "Send code to new email" }));
    expect(account.requestEmailCode).toHaveBeenCalledWith({ email: "new@example.com", reauth: "grant-1" });

    await userEvent.type(await screen.findByLabelText("Code"), "222222");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    // The grant lapsed: confirm again, with the new email's code still there.
    await userEvent.click(await screen.findByRole("button", { name: "Send code" }));
    expect((screen.getByLabelText("Code") as HTMLInputElement).value).toBe("222222");
    await userEvent.type(await screen.findByLabelText("Confirmation code"), "333333");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(account.reauth).toHaveBeenLastCalledWith({ code: "333333" });
    expect(account.setEmail).toHaveBeenLastCalledWith({ email: "new@example.com", code: "222222", reauth: "grant-2" });
    await vi.waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it("asks again on the save step once the grant it opened with runs out", async () => {
    let held: { readonly reauth: string } | undefined = { reauth: "grant-0" };
    const account: AccountModel = {
      ...fakeAccount(signedIn({ email: "old@example.com" })),
      identities: vi.fn(() => Promise.resolve({ ok: true as const, value: { hasPassword: true, identities: [] } })),
      recentGrant: () => held,
      forgetGrant: () => {
        held = undefined;
      },
    };
    render(<EmailForm account={account} submitLabel="Save" onSaved={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("Email"), "new@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Send code to new email" }));
    expect(account.requestEmailCode).toHaveBeenCalledWith({ email: "new@example.com", reauth: "grant-0" });
    held = undefined;
    await userEvent.type(await screen.findByLabelText("Code"), "222222");
    expect(screen.getByLabelText("Password")).toBeTruthy();
  });
});

