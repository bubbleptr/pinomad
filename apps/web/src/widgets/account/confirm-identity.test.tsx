// The confirmation step (ADR-0044 §6): the password on an account that has
// one, a mailed code traded for a re-auth grant on one that doesn't.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AccountConfirmation } from "@pinomad/client/account.ts";
import type { AccountModel } from "../../entities/account/account-model.ts";
import { fakeAccount, signedIn } from "../../test/story-fixtures.tsx";
import { useConfirmIdentity } from "./confirm-identity.tsx";

function Harness({ account, onConfirmed }: { account: AccountModel; onConfirmed: (value: AccountConfirmation) => void }) {
  const identity = useConfirmIdentity(account);
  return (
    <div>
      {identity.field}
      <button
        type="button"
        disabled={!identity.ready}
        onClick={() => void identity.confirm().then((result) => result.ok && onConfirmed(result.value))}
      >
        Go
      </button>
    </div>
  );
}

const account = (hasPassword: boolean): AccountModel => ({
  ...fakeAccount(signedIn({ email: "kieran@example.com" })),
  identities: vi.fn(() => Promise.resolve({ ok: true as const, value: { hasPassword, identities: [] } })),
  reauth: vi.fn(() => Promise.resolve({ ok: true as const, value: { reauth: "grant-1", expiresAt: Date.now() + 300_000 } })),
  requestReauthCode: vi.fn(() => Promise.resolve({ ok: true as const, value: undefined })),
});

describe("useConfirmIdentity", () => {
  it("asks for the password on an account that has one", async () => {
    const model = account(true);
    const confirmed = vi.fn();
    render(<Harness account={model} onConfirmed={confirmed} />);
    await userEvent.type(await screen.findByLabelText("Password"), "pw");
    await userEvent.click(screen.getByRole("button", { name: "Go" }));
    await vi.waitFor(() => expect(confirmed).toHaveBeenCalledWith("pw"));
    expect(model.requestReauthCode).not.toHaveBeenCalled();
  });

  it("mails a code to an account without a password and confirms with the grant", async () => {
    const model = account(false);
    const confirmed = vi.fn();
    render(<Harness account={model} onConfirmed={confirmed} />);
    expect(await screen.findByText("We'll email a code to kieran@example.com.")).toBeTruthy();
    expect(screen.queryByLabelText("Password")).toBeNull();
    expect((screen.getByRole("button", { name: "Go" }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Send code" }));
    expect(model.requestReauthCode).toHaveBeenCalledOnce();
    await userEvent.type(await screen.findByLabelText("Confirmation code"), "123456");
    await userEvent.click(screen.getByRole("button", { name: "Go" }));
    await vi.waitFor(() => expect(confirmed).toHaveBeenCalledWith({ reauth: "grant-1" }));
    expect(model.reauth).toHaveBeenCalledWith({ code: "123456" });
    // A second try reuses the grant: the code was single-use.
    await userEvent.click(screen.getByRole("button", { name: "Go" }));
    await vi.waitFor(() => expect(confirmed).toHaveBeenCalledTimes(2));
    expect(model.reauth).toHaveBeenCalledOnce();
  });
});
