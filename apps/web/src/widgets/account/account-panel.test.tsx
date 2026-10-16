// The account panel against a fake model: which host rows offer which action,
// and that a key change or revocation never re-pairs until the user asks.
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AccountHost, AccountHostMatch } from "@pinomad/client/account.ts";
import type { StoredHost } from "@pinomad/client/stored-host.ts";
import { AccountContext } from "../../entities/account/account-context.tsx";
import { ACTIVE_HOST_KEY } from "../../entities/host/host-store.ts";
import type { AccountModel, AccountState } from "../../entities/account/account-model.ts";
import { AccountPanel } from "./account-panel.tsx";

const KEY_A = "A".repeat(43);
const KEY_B = "B".repeat(43);

function host(overrides: Partial<AccountHost>): AccountHost {
  return { hostId: "h".repeat(43), name: "box", noisePublicKey: KEY_A, online: true, lastSeenAt: Date.now(), pairing: "available", ...overrides };
}

const stored = (hostKey: string): StoredHost => ({ url: "wss://s/c/x", hostKey, privateKey: "p".repeat(43) });

function fakeModel(initial: AccountState): AccountModel & { setState(next: AccountState): void } {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
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
    login: vi.fn(() => Promise.resolve({ ok: true as const, value: undefined })),
    logout: vi.fn(() => Promise.resolve({ ok: true as const, value: undefined })),
    revokeAll: vi.fn(() => Promise.resolve({ ok: true as const, value: undefined })),
    refreshHosts: vi.fn(() => Promise.resolve({ ok: true as const, value: [] })),
    createJoinToken: vi.fn(() => Promise.reject(new Error("unused"))),
    pairHost: vi.fn(() => Promise.resolve({ ok: false as const, error: { code: "host_timeout" } })),
    retryUnsavedHost: vi.fn(() => Promise.resolve({ ok: true as const, value: undefined })),
    hostRejected: vi.fn(),
  };
}

function signedIn(hosts: AccountHostMatch[], rejectedHostKeys: string[] = []): AccountState {
  return { status: "signed-in", mode: "cookie", user: "kieran", serverOrigin: "https://nomad.example", hosts, rejectedHostKeys };
}

function renderPanel(model: AccountModel) {
  render(
    <AccountContext.Provider value={model}>
      <AccountPanel />
    </AccountContext.Provider>,
  );
}

const row = (name: string) => screen.getByText(name).closest("li")!;

describe("AccountPanel", () => {
  it("asks for the server address only on clients that pick their server", () => {
    renderPanel(fakeModel({ status: "signed-out", mode: "cookie" }));
    expect(screen.queryByLabelText("Server")).toBeNull();
  });

  it("prefills and submits the server address in bearer mode", async () => {
    const model = fakeModel({ status: "signed-out", mode: "bearer", serverOrigin: "https://nomad.example" });
    renderPanel(model);
    expect(screen.getByLabelText("Server")).toHaveValue("https://nomad.example");
    await userEvent.type(screen.getByLabelText("Username"), "kieran");
    await userEvent.type(screen.getByLabelText("Password"), "pw{Enter}");
    expect(model.login).toHaveBeenCalledWith({ username: "kieran", password: "pw", serverOrigin: "https://nomad.example" });
  });

  it("only lets the user pair hosts the server says are available", () => {
    renderPanel(
      fakeModel(
        signedIn([
          { host: host({ name: "up", hostId: "u".repeat(43) }), status: "unpaired", linkable: false },
          { host: host({ name: "down", hostId: "d".repeat(43), online: false, pairing: "offline" }), status: "unpaired", linkable: false },
          { host: host({ name: "old", hostId: "o".repeat(43), pairing: "host_too_old" }), status: "unpaired", linkable: false },
        ]),
      ),
    );
    expect(within(row("up")).getByRole("button", { name: "Pair" })).toBeEnabled();
    expect(within(row("down")).getByRole("button", { name: "Pair" })).toBeDisabled();
    expect(within(row("old")).getByRole("button", { name: "Pair" })).toBeDisabled();
    expect(within(row("old")).getByText(/pinomad upgrade/)).toBeTruthy();
  });

  it("reports a key change and re-pairs only on an explicit click", async () => {
    const model = fakeModel(signedIn([{ host: host({ noisePublicKey: KEY_B }), status: "key_changed", stored: stored(KEY_A), linkable: false }]));
    renderPanel(model);
    expect(within(row("box")).getByText("Key changed")).toBeTruthy();
    expect(model.pairHost).not.toHaveBeenCalled();
    await userEvent.click(within(row("box")).getByRole("button", { name: "Pair again" }));
    expect(model.pairHost).toHaveBeenCalledWith("h".repeat(43));
    // The pairing failure surfaces in words, not as a code.
    expect(await screen.findByText(/didn't answer in time/)).toBeTruthy();
  });

  it("offers a re-pair for a host that refused this device instead of Connect", () => {
    renderPanel(fakeModel(signedIn([{ host: host({}), status: "paired", stored: stored(KEY_A), linkable: false }], [KEY_A])));
    expect(within(row("box")).queryByRole("button", { name: "Connect" })).toBeNull();
    expect(within(row("box")).getByRole("button", { name: "Pair again" })).toBeEnabled();
  });

  it("still warns after a failed Sign out everywhere lands on the sign-in form", async () => {
    const model = fakeModel(signedIn([]));
    // Like the real model: signed-out even when the request never reached the server.
    model.revokeAll = vi.fn(() => {
      model.setState({ status: "signed-out", mode: "cookie" });
      return Promise.resolve({ ok: false as const, error: { code: "network" } });
    });
    renderPanel(model);
    await userEvent.click(screen.getByRole("button", { name: "Sign out everywhere" }));
    await userEvent.click(screen.getByRole("button", { name: "Sign out everywhere?" }));
    expect(await screen.findByText(/Other devices may still be signed in/)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeTruthy();
  });

  it("connects to the host once a failed save succeeds on retry", async () => {
    localStorage.removeItem(ACTIVE_HOST_KEY);
    const model = fakeModel({ ...signedIn([]), unsavedHost: stored(KEY_A) } as AccountState);
    renderPanel(model);
    await act(async () => {
      await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    expect(model.retryUnsavedHost).toHaveBeenCalled();
    expect(localStorage.getItem(ACTIVE_HOST_KEY)).toBe(KEY_A);
  });
});
