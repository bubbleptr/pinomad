// The account panel against a fake model: which host rows offer which action,
// and that a key change or revocation never re-pairs until the user asks.
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AccountHost, AccountHostMatch } from "@pinomad/client/account.ts";
import type { StoredHost } from "@pinomad/client/stored-host.ts";
import { AccountContext } from "../../entities/account/account-context.tsx";
import { HostsContext } from "../../entities/host/host-store.ts";
import { fakeHosts } from "../../test/story-fixtures.tsx";
import type { AccountModel, AccountState } from "../../entities/account/account-model.ts";
import { AccountPanel, accountErrorMessage } from "./account-panel.tsx";

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
    register: vi.fn(() => Promise.resolve({ ok: false as const, error: { code: "invalid_invite", status: 403 } })),
    logout: vi.fn(() => Promise.resolve({ ok: true as const, value: undefined })),
    revokeAll: vi.fn(() => Promise.resolve({ ok: true as const, value: undefined })),
    refreshHosts: vi.fn(() => Promise.resolve({ ok: true as const, value: [] })),
    createJoinToken: vi.fn(() => Promise.reject(new Error("unused"))),
    listInvites: vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        value: [
          { id: 2, createdAt: Date.now(), expiresAt: Date.now() + 86_400_000 },
          { id: 1, createdAt: 0, expiresAt: Date.now() + 1000, usedAt: 1, usedBy: "bob" },
        ],
      }),
    ),
    createInvite: vi.fn(() => Promise.resolve({ ok: true as const, value: { code: "fresh-code", expiresAt: Date.now() + 86_400_000 } })),
    revokeInvite: vi.fn(() => Promise.resolve({ ok: true as const, value: undefined })),
    pairHost: vi.fn(() => Promise.resolve({ ok: false as const, error: { code: "host_timeout" } })),
    retryUnsavedHost: vi.fn(() => Promise.resolve({ ok: true as const, value: undefined })),
    hostRejected: vi.fn(),
  };
}

function signedIn(hosts: AccountHostMatch[], rejectedHostKeys: string[] = []): Extract<AccountState, { status: "signed-in" }> {
  return {
    status: "signed-in",
    mode: "cookie",
    user: "kieran",
    admin: false,
    serverOrigin: "https://nomad.example",
    hosts,
    rejectedHostKeys,
    unsavedHosts: [],
  };
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

  it("signs a fresh desktop in to the official server without asking for an address", async () => {
    const model = fakeModel({ status: "signed-out", mode: "bearer" });
    renderPanel(model);
    await userEvent.type(screen.getByLabelText("Username"), "kieran");
    await userEvent.type(screen.getByLabelText("Password"), "pw{Enter}");
    expect(model.login).toHaveBeenCalledWith({ username: "kieran", password: "pw", serverOrigin: "https://app.pinomad.si" });
  });

  it("signs in to a self-hosted server once the user edits the address", async () => {
    const model = fakeModel({ status: "signed-out", mode: "bearer" });
    renderPanel(model);
    await userEvent.clear(screen.getByLabelText("Server"));
    await userEvent.type(screen.getByLabelText("Server"), "https://nomad.example");
    await userEvent.type(screen.getByLabelText("Username"), "kieran");
    await userEvent.type(screen.getByLabelText("Password"), "pw{Enter}");
    expect(model.login).toHaveBeenCalledWith({ username: "kieran", password: "pw", serverOrigin: "https://nomad.example" });
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
          { host: host({ name: "up", hostId: "u".repeat(43) }), status: "unpaired", linkable: false, autoRegister: true },
          { host: host({ name: "down", hostId: "d".repeat(43), online: false, pairing: "offline" }), status: "unpaired", linkable: false, autoRegister: true },
          { host: host({ name: "old", hostId: "o".repeat(43), pairing: "host_too_old" }), status: "unpaired", linkable: false, autoRegister: true },
        ]),
      ),
    );
    expect(within(row("up")).getByRole("button", { name: "Pair" })).toBeEnabled();
    expect(within(row("down")).getByRole("button", { name: "Pair" })).toBeDisabled();
    expect(within(row("old")).getByRole("button", { name: "Pair" })).toBeDisabled();
    expect(within(row("old")).getByText(/pinomad upgrade/)).toBeTruthy();
  });

  it("reports a key change and re-pairs only on an explicit click", async () => {
    const model = fakeModel(signedIn([{ host: host({ noisePublicKey: KEY_B }), status: "key_changed", stored: stored(KEY_A), linkable: false, autoRegister: false }]));
    renderPanel(model);
    expect(within(row("box")).getByText("Key changed")).toBeTruthy();
    expect(model.pairHost).not.toHaveBeenCalled();
    await userEvent.click(within(row("box")).getByRole("button", { name: "Pair again" }));
    expect(model.pairHost).toHaveBeenCalledWith("h".repeat(43));
    // The pairing failure surfaces in words, not as a code.
    expect(await screen.findByText(/didn't answer in time/)).toBeTruthy();
  });

  it("offers a re-pair for a host that refused this device instead of Connect", () => {
    renderPanel(fakeModel(signedIn([{ host: host({}), status: "paired", stored: stored(KEY_A), linkable: false, autoRegister: false }], [KEY_A])));
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

  it("focuses the host once a failed save succeeds on retry", async () => {
    const model = fakeModel({ ...signedIn([]), unsavedHosts: [{ ...stored(KEY_A), account: { serverOrigin: "https://nomad.example", hostId: "h1" } }] });
    const focusHost = vi.fn();
    const hosts = { ...fakeHosts([], null), focusHost };
    render(
      <HostsContext.Provider value={hosts}>
        <AccountContext.Provider value={model}>
          <AccountPanel />
        </AccountContext.Provider>
      </HostsContext.Provider>,
    );
    await act(async () => {
      await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    expect(model.retryUnsavedHost).toHaveBeenCalledWith("h1");
    expect(focusHost).toHaveBeenCalledWith(KEY_A);
  });
});

describe("invite sign-up (#449)", () => {
  it("switches to sign-up and sends the invite, name and password", async () => {
    const model = fakeModel({ status: "signed-out", mode: "cookie" });
    renderPanel(model);
    await userEvent.click(screen.getByRole("button", { name: "Create an account" }));
    await userEvent.type(screen.getByLabelText("Invite code"), " code-1 ");
    await userEvent.type(screen.getByLabelText("Username"), "bob");
    await userEvent.type(screen.getByLabelText("Password"), "long password here");
    await act(async () => {
      await userEvent.click(screen.getByRole("button", { name: "Create account" }));
    });
    expect(model.register).toHaveBeenCalledWith({ invite: "code-1", username: "bob", password: "long password here" });
    expect(screen.getByText(/invite code isn't valid/)).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Sign in instead" }));
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeTruthy();
  });

  it("hides invites from accounts that aren't the admin", async () => {
    const plain = fakeModel(signedIn([]));
    renderPanel(plain);
    expect(screen.queryByText("Invites")).toBeNull();
    expect(plain.listInvites).not.toHaveBeenCalled();
  });

  it("lists invites, creates one, and revokes an unused one", async () => {
    const model = fakeModel({ ...signedIn([]), admin: true });
    renderPanel(model);
    expect(await screen.findByText("Used by bob")).toBeTruthy();
    await act(async () => {
      await userEvent.click(screen.getByRole("button", { name: "Create invite" }));
    });
    expect(screen.getByText("fresh-code")).toBeTruthy();
    await act(async () => {
      await userEvent.click(screen.getByRole("button", { name: "Revoke" }));
    });
    expect(model.revokeInvite).toHaveBeenCalledWith(2);
  });
});

describe("accountErrorMessage pairing paths", () => {
  it("separates an actual refusal from unreachable, timeout and unsupported paths", () => {
    expect(accountErrorMessage({ code: "pair_rejected" })).toContain("refused this device");
    expect(accountErrorMessage({ code: "pair_unreachable" })).toContain("Couldn't reach the host");
    expect(accountErrorMessage({ code: "pair_timeout" })).toContain("didn't answer");
    expect(accountErrorMessage({ code: "pair_unsupported" })).toContain("can't connect to any address");
  });
});
