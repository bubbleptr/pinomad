// The signed-out screen (ADR-0044): provider buttons only where the server
// offers them and this client can run the flow, the two-step email sign-up,
// and the password reset that lands back on sign-in.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AuthMethods } from "@pinomad/client/account.ts";
import type { AccountModel } from "../../entities/account/account-model.ts";
import { fakeAccount } from "../../test/story-fixtures.tsx";
import { SignInScreen } from "./sign-in.tsx";

const ALL: AuthMethods = { registration: true, email: true, providers: ["google", "github", "apple"] };

function model(overrides: Partial<AccountModel> = {}, methods: AuthMethods = ALL): AccountModel {
  return {
    ...fakeAccount({ status: "signed-out", mode: "cookie" }),
    authMethods: vi.fn(() => Promise.resolve({ ok: true as const, value: methods })),
    ...overrides,
  };
}

describe("SignInScreen", () => {
  it("offers the server's providers above the email form", async () => {
    const account = model({}, { registration: true, email: true, providers: ["github", "google"] });
    render(<SignInScreen account={account} />);
    const google = await screen.findByRole("button", { name: "Continue with Google" });
    const github = screen.getByRole("button", { name: "Continue with GitHub" });
    expect(screen.queryByRole("button", { name: "Continue with Apple" })).toBeNull();
    // Google first whatever order the server listed them in, and both before the email form.
    expect(google.compareDocumentPosition(github) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(github.compareDocumentPosition(screen.getByLabelText("Email")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText("or")).toBeTruthy();
    await userEvent.click(github);
    expect(account.providerSignIn).toHaveBeenCalledWith({ provider: "github" });
  });

  it("shows no providers or divider when the server has none", async () => {
    render(<SignInScreen account={model({}, { registration: false, email: false, providers: [] })} />);
    await screen.findByLabelText("Email");
    await vi.waitFor(() => expect(screen.queryByRole("button", { name: /Continue with/ })).toBeNull());
    expect(screen.queryByText("or")).toBeNull();
    // No sign-up and no mailed codes: neither link.
    expect(screen.queryByRole("button", { name: "Create an account" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Forgot password?" })).toBeNull();
  });

  it("shows no providers where this client can't run the flow", async () => {
    render(<SignInScreen account={{ ...model(), providerFlow: undefined }} />);
    await screen.findByRole("button", { name: "Create an account" });
    expect(screen.queryByRole("button", { name: /Continue with/ })).toBeNull();
  });

  it("signs in with whatever is typed as the email, a legacy username too", async () => {
    const account = model();
    render(<SignInScreen account={account} />);
    await userEvent.type(screen.getByLabelText("Email"), "kieran");
    await userEvent.type(screen.getByLabelText("Password"), "pw{Enter}");
    expect(account.login).toHaveBeenCalledWith({ username: "kieran", password: "pw" });
  });

  it("creates an account in two steps: the code, then the code and a password", async () => {
    const account = model();
    render(<SignInScreen account={account} />);
    await userEvent.click(await screen.findByRole("button", { name: "Create an account" }));
    await userEvent.type(screen.getByLabelText("Email"), "ada@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Send code" }));
    expect(account.requestSignupCode).toHaveBeenCalledWith({ email: "ada@example.com" });
    expect(await screen.findByText("Enter the 6-digit code we sent to ada@example.com.")).toBeTruthy();
    const code = screen.getByLabelText("Code");
    expect(code.getAttribute("autocomplete")).toBe("one-time-code");
    expect(code.getAttribute("inputmode")).toBe("numeric");
    expect(screen.getByLabelText("New password").getAttribute("autocomplete")).toBe("new-password");
    await userEvent.type(code, "123456");
    // The 12-character rule shows only as an error.
    await userEvent.type(screen.getByLabelText("New password"), "short");
    await userEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByText("Use a password of at least 12 characters.")).toBeTruthy();
    expect(account.register).not.toHaveBeenCalled();
    await userEvent.type(screen.getByLabelText("New password"), " and longer");
    await userEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(account.register).toHaveBeenCalledWith({ email: "ada@example.com", code: "123456", password: "short and longer" });
  });

  it("holds Resend code for 30 seconds and goes back for a different email", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const account = model();
      render(<SignInScreen account={account} />);
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await user.click(await screen.findByRole("button", { name: "Create an account" }));
      await user.type(screen.getByLabelText("Email"), "ada@example.com");
      await user.click(screen.getByRole("button", { name: "Send code" }));
      const resend = await screen.findByRole("button", { name: /Resend code/ });
      expect(resend.hasAttribute("disabled") || resend.getAttribute("aria-disabled") === "true").toBe(true);
      await vi.advanceTimersByTimeAsync(31_000);
      const ready = await screen.findByRole("button", { name: "Resend code" });
      await user.click(ready);
      expect(account.requestSignupCode).toHaveBeenCalledTimes(2);
      await user.click(screen.getByRole("button", { name: "Use a different email" }));
      expect((screen.getByLabelText("Email") as HTMLInputElement).value).toBe("ada@example.com");
      expect(screen.queryByLabelText("Code")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("resets a forgotten password and lands on sign-in with the email filled in", async () => {
    const account = model();
    render(<SignInScreen account={account} />);
    await userEvent.click(await screen.findByRole("button", { name: "Forgot password?" }));
    await userEvent.type(screen.getByLabelText("Email"), "ada@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Send code" }));
    expect(account.requestPasswordReset).toHaveBeenCalledWith({ email: "ada@example.com" });
    await userEvent.type(await screen.findByLabelText("Code"), "654321");
    await userEvent.type(screen.getByLabelText("New password"), "a brand new password");
    await userEvent.click(screen.getByRole("button", { name: "Reset password" }));
    expect(account.resetPassword).toHaveBeenCalledWith({ email: "ada@example.com", code: "654321", password: "a brand new password" });
    expect(await screen.findByText("Password reset. Sign in with your new password.")).toBeTruthy();
    expect((screen.getByLabelText("Email") as HTMLInputElement).value).toBe("ada@example.com");
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
  });

  it("says why a provider sign-in came back refused", async () => {
    render(<SignInScreen account={model()} initialError="access_denied" />);
    expect(await screen.findByText("Sign-in was cancelled.")).toBeTruthy();
  });

  it("asks the typed server for its methods in bearer mode, and only a secure one", async () => {
    const account = { ...model(), providerFlow: "loopback" as const };
    let origin = "http://nomad.example.com";
    const setOrigin = (next: string): void => {
      origin = next;
    };
    const { rerender } = render(<SignInScreen account={account} server={{ origin, setOrigin }} />);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(account.authMethods).not.toHaveBeenCalled();
    rerender(<SignInScreen account={account} server={{ origin: "https://nomad.example.com", setOrigin }} />);
    await screen.findByRole("button", { name: "Continue with Google" });
    expect(account.authMethods).toHaveBeenCalledWith("https://nomad.example.com");
    await userEvent.click(screen.getByRole("button", { name: "Continue with Google" }));
    expect(account.providerSignIn).toHaveBeenCalledWith({ provider: "google", serverOrigin: "https://nomad.example.com" });
  });
});
