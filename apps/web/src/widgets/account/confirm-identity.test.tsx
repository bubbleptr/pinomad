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
        onClick={() =>
          void identity.confirm().then((result) => {
            if (result.ok) onConfirmed(result.value);
            else identity.claim(result.error);
          })
        }
      >
        Go
      </button>
      <button type="button" onClick={identity.reset}>Refused</button>
    </div>
  );
}

/** The model's grant as the real one keeps it: set by a successful reauth, dropped by forgetGrant. */
const account = (hasPassword: boolean): AccountModel => {
  let held: { readonly reauth: string } | undefined;
  return {
    ...fakeAccount(signedIn({ email: "kieran@example.com" })),
    identities: vi.fn(() => Promise.resolve({ ok: true as const, value: { hasPassword, identities: [] } })),
    reauth: vi.fn(() => {
      held = { reauth: "grant-1" };
      return Promise.resolve({ ok: true as const, value: { reauth: "grant-1", expiresAt: Date.now() + 300_000 } });
    }),
    recentGrant: () => held,
    forgetGrant: vi.fn(() => {
      held = undefined;
    }),
    requestReauthCode: vi.fn(() => Promise.resolve({ ok: true as const, value: undefined })),
  };
};

describe("useConfirmIdentity", () => {
  it("asks for the password on an account that has one and trades it for a grant", async () => {
    const model = account(true);
    const confirmed = vi.fn();
    render(<Harness account={model} onConfirmed={confirmed} />);
    await userEvent.type(await screen.findByLabelText("Password"), "pw");
    await userEvent.click(screen.getByRole("button", { name: "Go" }));
    await vi.waitFor(() => expect(confirmed).toHaveBeenCalledWith({ reauth: "grant-1" }));
    expect(model.reauth).toHaveBeenCalledWith({ password: "pw" });
    expect(model.requestReauthCode).not.toHaveBeenCalled();
  });

  it("skips the field while the last grant lasts, and asks again once it is refused", async () => {
    const model = account(true);
    const confirmed = vi.fn();
    const first = render(<Harness account={model} onConfirmed={confirmed} />);
    await userEvent.type(await screen.findByLabelText("Password"), "pw");
    await userEvent.click(screen.getByRole("button", { name: "Go" }));
    await vi.waitFor(() => expect(confirmed).toHaveBeenCalledOnce());
    first.unmount();

    // The next guarded action, a minute later.
    render(<Harness account={model} onConfirmed={confirmed} />);
    await vi.waitFor(() => expect(model.identities).toHaveBeenCalledTimes(2));
    expect(screen.queryByLabelText("Password")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Go" }));
    await vi.waitFor(() => expect(confirmed).toHaveBeenCalledTimes(2));
    expect(confirmed).toHaveBeenLastCalledWith({ reauth: "grant-1" });
    expect(model.reauth).toHaveBeenCalledOnce();

    await userEvent.click(screen.getByRole("button", { name: "Refused" }));
    expect(model.forgetGrant).toHaveBeenCalled();
    expect(await screen.findByLabelText("Password")).toBeTruthy();
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

  it("hands nothing over when the dialog closed while the password was being checked", async () => {
    const model = account(true);
    let answer!: () => void;
    vi.mocked(model.reauth).mockImplementationOnce(
      () => new Promise((resolve) => (answer = () => resolve({ ok: true, value: { reauth: "grant-1", expiresAt: Date.now() + 300_000 } }))),
    );
    const confirmed = vi.fn();
    const view = render(<Harness account={model} onConfirmed={confirmed} />);
    await userEvent.type(await screen.findByLabelText("Password"), "pw");
    await userEvent.click(screen.getByRole("button", { name: "Go" }));
    view.unmount();
    answer();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(confirmed).not.toHaveBeenCalled();
  });

  it("sends the password itself to a server without re-auth grants", async () => {
    const model = account(true);
    vi.mocked(model.reauth).mockResolvedValueOnce({ ok: false, error: { code: "unknown", status: 404 } });
    const confirmed = vi.fn();
    render(<Harness account={model} onConfirmed={confirmed} />);
    await userEvent.type(await screen.findByLabelText("Password"), "pw");
    await userEvent.click(screen.getByRole("button", { name: "Go" }));
    await vi.waitFor(() => expect(confirmed).toHaveBeenCalledWith("pw"));
  });

  it("shows a wrong password on the password field until it is edited", async () => {
    const model = account(true);
    vi.mocked(model.reauth).mockResolvedValueOnce({ ok: false, error: { code: "wrong_password" } });
    render(<Harness account={model} onConfirmed={vi.fn()} />);
    const password = await screen.findByLabelText("Password");
    await userEvent.type(password, "pw");
    await userEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(await screen.findByText("The password is wrong.")).toBeTruthy();
    expect(password.getAttribute("aria-invalid")).toBe("true");
    await userEvent.type(password, "x");
    expect(screen.queryByText("The password is wrong.")).toBeNull();
  });

  it("shows a wrong code on the code field, and a failed send beside Send code", async () => {
    const model = account(false);
    vi.mocked(model.requestReauthCode).mockResolvedValueOnce({ ok: false, error: { code: "rate_limited" } });
    vi.mocked(model.reauth).mockResolvedValueOnce({ ok: false, error: { code: "invalid_code" } });
    render(<Harness account={model} onConfirmed={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Send code" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Too many attempts. Wait a few minutes and try again.");
    await userEvent.click(screen.getByRole("button", { name: "Send code" }));
    const code = await screen.findByLabelText("Confirmation code");
    await userEvent.type(code, "123456");
    await userEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(await screen.findByText(/That code is wrong/)).toBeTruthy();
    expect(code.getAttribute("aria-invalid")).toBe("true");
  });

  it("drops the field's error when another try starts, whatever that try says", async () => {
    const model = account(true);
    vi.mocked(model.reauth)
      .mockResolvedValueOnce({ ok: false, error: { code: "wrong_password" } })
      .mockResolvedValueOnce({ ok: false, error: { code: "rate_limited" } });
    render(<Harness account={model} onConfirmed={vi.fn()} />);
    const password = await screen.findByLabelText("Password");
    await userEvent.type(password, "pw");
    await userEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(await screen.findByText("The password is wrong.")).toBeTruthy();
    // Again, without editing: the next answer isn't about the password.
    await userEvent.click(screen.getByRole("button", { name: "Go" }));
    await vi.waitFor(() => expect(model.reauth).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(screen.queryByText("The password is wrong.")).toBeNull());
    expect(password.getAttribute("aria-invalid")).toBeNull();
  });
});
