// The "no account yet" page after a provider sign-in (ADR-0044 §4): whose
// identity it is, creating the account (with a password when the server
// asks for one), linking it to the signed-in account or to one signed in on
// the spot, a native app's redirect, and an expired id.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountState } from "../../entities/account/account-model.ts";
import { AccountContext } from "../../entities/account/account-context.tsx";
import { resetOAuthReturnForTests } from "../../entities/account/oauth-return.ts";
import { fakeAccount, signedIn } from "../../test/story-fixtures.tsx";
import type { AccountModel } from "../../entities/account/account-model.ts";
import { PendingSignInRoute, PendingSignInSteps } from "./pending-sign-in.tsx";

const ID = "p".repeat(43);

function model(state: AccountState, overrides: Partial<AccountModel> = {}): AccountModel {
  return {
    ...fakeAccount(state),
    pendingSignIn: vi.fn(() => Promise.resolve({ ok: true as const, value: { provider: "google", email: "ada@gmail.com" } })),
    authMethods: vi.fn(() => Promise.resolve({ ok: true as const, value: { registration: true, email: true, providers: ["google"] } })),
    identities: vi.fn(() => Promise.resolve({ ok: true as const, value: { hasPassword: true, identities: [] } })),
    ...overrides,
  };
}

const signedOut: AccountState = { status: "signed-out", mode: "cookie" };

function renderSteps(account: AccountModel, navigate = vi.fn(), onDone = vi.fn()) {
  render(<PendingSignInSteps account={account} id={ID} navigate={navigate} onDone={onDone} />);
  return { navigate, onDone };
}

afterEach(() => {
  history.replaceState(null, "", "/");
  resetOAuthReturnForTests();
});

describe("PendingSignInSteps", () => {
  it("shows whose identity it is and creates the account", async () => {
    const account = model(signedOut);
    const { onDone } = renderSteps(account);
    expect(await screen.findByText("No PiNomad account for ada@gmail.com yet")).toBeTruthy();
    expect(screen.getByText("Google")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(account.createFromPending).toHaveBeenCalledWith(ID, undefined);
    expect(onDone).toHaveBeenCalled();
  });

  it("asks for a password first on a server that can't mail codes", async () => {
    const account = model(signedOut, {
      authMethods: vi.fn(() => Promise.resolve({ ok: true as const, value: { registration: true, email: false, providers: ["google"] } })),
    });
    renderSteps(account);
    const field = await screen.findByLabelText("New password");
    expect((screen.getByRole("button", { name: "Create account" }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(field, "a long new password");
    await userEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(account.createFromPending).toHaveBeenCalledWith(ID, { password: "a long new password" });
  });

  it("asks for a password when the server answers password_required", async () => {
    const createFromPending = vi
      .fn<AccountModel["createFromPending"]>()
      .mockResolvedValueOnce({ ok: false, error: { code: "password_required", status: 400 } })
      .mockResolvedValueOnce({ ok: true, value: {} });
    const account = model(signedOut, { createFromPending });
    const { onDone } = renderSteps(account);
    await userEvent.click(await screen.findByRole("button", { name: "Create account" }));
    await userEvent.type(await screen.findByLabelText("New password"), "a long new password{Enter}");
    expect(createFromPending).toHaveBeenLastCalledWith(ID, { password: "a long new password" });
    await vi.waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it("sends the browser on to a native app's redirect", async () => {
    const redirect = "http://127.0.0.1:5000/callback?code=c&state=s";
    const account = model(signedOut, { createFromPending: vi.fn(() => Promise.resolve({ ok: true as const, value: { redirect } })) });
    const { navigate, onDone } = renderSteps(account);
    await userEvent.click(await screen.findByRole("button", { name: "Create account" }));
    expect(navigate).toHaveBeenCalledWith(redirect);
    expect(onDone).not.toHaveBeenCalled();
  });

  it("links to the signed-in account after the confirmation", async () => {
    const account = model(signedIn({ email: "kieran@example.com" }));
    const { onDone } = renderSteps(account);
    await userEvent.click(await screen.findByRole("button", { name: "I already have an account" }));
    expect(screen.getByText("Link Google to kieran@example.com")).toBeTruthy();
    await userEvent.type(await screen.findByLabelText("Password"), "my password");
    await userEvent.click(screen.getByRole("button", { name: "Link Google" }));
    expect(account.linkPending).toHaveBeenCalledWith(ID, { reauth: "grant" });
    await vi.waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it("signed out, signs in and links with the same password", async () => {
    const account = model(signedOut);
    renderSteps(account);
    await userEvent.click(await screen.findByRole("button", { name: "I already have an account" }));
    expect(screen.getByText(/Sign in with it first, then link this one in Settings/)).toBeTruthy();
    await userEvent.type(screen.getByLabelText("Email"), "ada@example.com");
    await userEvent.type(screen.getByLabelText("Password"), "pw{Enter}");
    expect(account.signInAndLinkPending).toHaveBeenCalledWith(ID, { username: "ada@example.com", password: "pw" });
  });

  it("puts wrong credentials on the password field, and a refusal beside the button", async () => {
    const account = model(signedOut, {
      signInAndLinkPending: vi
        .fn<AccountModel["signInAndLinkPending"]>()
        .mockResolvedValueOnce({ ok: false, error: { code: "invalid_credentials", status: 401 } })
        .mockResolvedValueOnce({ ok: false, error: { code: "identity_taken", status: 409 } }),
    });
    renderSteps(account);
    await userEvent.click(await screen.findByRole("button", { name: "I already have an account" }));
    await userEvent.type(screen.getByLabelText("Email"), "ada@example.com");
    const password = screen.getByLabelText("Password");
    await userEvent.type(password, "pw{Enter}");
    expect(await screen.findByText("Wrong email or password.")).toBeTruthy();
    expect(password.getAttribute("aria-invalid")).toBe("true");
    await userEvent.type(password, "2{Enter}");
    expect((await screen.findByRole("alert")).textContent).toBe("That account is already linked to another PiNomad account.");
    expect(password.getAttribute("aria-invalid")).toBeNull();
  });

  it("says an expired sign-in expired", async () => {
    const account = model(signedOut, { pendingSignIn: vi.fn(() => Promise.resolve({ ok: false as const, error: { code: "not_found", status: 404 } })) });
    const { onDone } = renderSteps(account);
    expect(await screen.findByText("This sign-in expired. Start again.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Back to sign-in" }));
    expect(onDone).toHaveBeenCalled();
  });
});

describe("PendingSignInRoute", () => {
  it("opens from ?oauth_pending= and takes it out of the address", async () => {
    history.replaceState(null, "", `/?oauth_pending=${ID}&keep=1`);
    const account = model(signedOut);
    render(
      <AccountContext.Provider value={account}>
        <PendingSignInRoute />
      </AccountContext.Provider>,
    );
    expect(await screen.findByText("No PiNomad account for ada@gmail.com yet")).toBeTruthy();
    expect(account.pendingSignIn).toHaveBeenCalledWith(ID);
    expect(window.location.search).toBe("?keep=1");
  });
});
