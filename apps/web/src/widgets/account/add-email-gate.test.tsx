// A legacy account the server wants an email for sees only the add-email
// card until it's saved (ADR-0044 §8).
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AccountModel, AccountState } from "../../entities/account/account-model.ts";
import { AccountContext } from "../../entities/account/account-context.tsx";
import { fakeAccount, signedIn } from "../../test/story-fixtures.tsx";
import { AddEmailGate } from "./add-email-gate.tsx";

function liveModel(initial: AccountState): AccountModel & { setState(next: AccountState): void } {
  let state = initial;
  const listeners = new Set<() => void>();
  const base = fakeAccount(initial);
  return {
    ...base,
    get state() {
      return state;
    },
    setState(next) {
      state = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    identities: vi.fn(() => Promise.resolve({ ok: true as const, value: { hasPassword: true, identities: [] } })),
  };
}

const renderGate = (account: AccountModel) =>
  render(
    <AccountContext.Provider value={account}>
      <AddEmailGate>
        <p>The app</p>
      </AddEmailGate>
    </AccountContext.Provider>,
  );

describe("AddEmailGate", () => {
  it("lets a signed-in account with an email straight through", () => {
    renderGate(liveModel(signedIn()));
    expect(screen.getByText("The app")).toBeTruthy();
  });

  it("holds the app until the email is saved", async () => {
    const legacy = signedIn({ user: "kieran", needsEmail: true });
    delete (legacy as { email?: string }).email;
    const account = liveModel(legacy);
    vi.mocked(account.setEmail).mockImplementation(async () => {
      account.setState(signedIn());
      return { ok: true, value: undefined };
    });
    renderGate(account);
    expect(screen.queryByText("The app")).toBeNull();
    expect(screen.getByText("Add an email to your account")).toBeTruthy();
    await userEvent.type(screen.getByLabelText("Email"), "kieran@example.com");
    await userEvent.type(await screen.findByLabelText("Password"), "my password");
    await userEvent.click(screen.getByRole("button", { name: "Send code to new email" }));
    expect(account.requestEmailCode).toHaveBeenCalledWith({ email: "kieran@example.com", password: "my password" });
    expect(await screen.findByText("Enter the 6-digit code we sent to kieran@example.com.")).toBeTruthy();
    await userEvent.type(screen.getByLabelText("Code"), "123456");
    await act(async () => {
      await userEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    expect(account.setEmail).toHaveBeenCalledWith({ email: "kieran@example.com", code: "123456", password: "my password" });
    expect(screen.getByText("The app")).toBeTruthy();
  });
});
