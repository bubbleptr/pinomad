// The account panel against a fake model: which host rows offer which action,
// and that a key change or revocation never re-pairs until the user asks.
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AccountDevice, AccountHost, AccountHostMatch } from "@pinomad/client/account.ts";
import type { StoredHost } from "@pinomad/client/stored-host.ts";
import { AccountContext } from "../../entities/account/account-context.tsx";
import { HostsContext } from "../../entities/host/host-store.ts";
import { fakeHosts } from "../../test/story-fixtures.tsx";
import type { AccountModel, AccountState } from "../../entities/account/account-model.ts";
import { accountErrorMessage } from "./account-error.ts";
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
    createJoinToken: vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        value: { token: "join-1", expiresAt: Date.now() + 600_000, command: "curl -fsSL https://pinomad.si/install.sh | sh -s -- join https://nomad.example join-1" },
      }),
    ),
    lookupHostLink: vi.fn(() => Promise.reject(new Error("unused"))),
    confirmHostLink: vi.fn(() => Promise.reject(new Error("unused"))),
    denyHostLink: vi.fn(() => Promise.reject(new Error("unused"))),
    lookupHostLinkRequest: vi.fn(() => Promise.reject(new Error("unused"))),
    confirmHostLinkRequest: vi.fn(() => Promise.reject(new Error("unused"))),
    denyHostLinkRequest: vi.fn(() => Promise.reject(new Error("unused"))),
    watchForHost: vi.fn(),
    changePassword: vi.fn(() => Promise.resolve({ ok: true as const, value: undefined })),
    deleteAccount: vi.fn(() => Promise.resolve({ ok: true as const, value: undefined })),
    listDevices: vi.fn(() => Promise.resolve({ ok: true as const, value: [] as readonly AccountDevice[] })),
    kickDevice: vi.fn(() => Promise.resolve({ ok: true as const, value: undefined })),
    removeHost: vi.fn(() => Promise.resolve({ ok: true as const, value: undefined })),
    pairHost: vi.fn(() => Promise.resolve({ ok: false as const, error: { code: "host_timeout" } })),
    retryUnsavedHost: vi.fn(() => Promise.resolve({ ok: true as const, value: undefined })),
    hostRejected: vi.fn(),
    providerFlow: "redirect",
    authMethods: vi.fn(() => Promise.resolve({ ok: true as const, value: { registration: true, email: true, providers: [] } })),
    requestSignupCode: vi.fn(() => Promise.resolve({ ok: true as const, value: undefined })),
    register: vi.fn(() => Promise.resolve({ ok: true as const, value: undefined })),
    requestPasswordReset: vi.fn(() => Promise.resolve({ ok: true as const, value: undefined })),
    resetPassword: vi.fn(() => Promise.resolve({ ok: true as const, value: undefined })),
    providerSignIn: vi.fn(() => new Promise<never>(() => {})),
    requestEmailCode: vi.fn(() => Promise.resolve({ ok: true as const, value: undefined })),
    setEmail: vi.fn(() => Promise.resolve({ ok: true as const, value: undefined })),
    identities: vi.fn(() => Promise.resolve({ ok: true as const, value: { hasPassword: true, identities: [] } })),
    requestReauthCode: vi.fn(() => Promise.resolve({ ok: true as const, value: undefined })),
    reauth: vi.fn(() => Promise.resolve({ ok: true as const, value: { reauth: "grant", expiresAt: Date.now() + 300_000 } })),
    linkProvider: vi.fn(() => new Promise<never>(() => {})),
    unlinkProvider: vi.fn(() => Promise.resolve({ ok: true as const, value: undefined })),
    pendingSignIn: vi.fn(() => Promise.reject(new Error("unused"))),
    createFromPending: vi.fn(() => Promise.reject(new Error("unused"))),
    linkPending: vi.fn(() => Promise.reject(new Error("unused"))),
    signInAndLinkPending: vi.fn(() => Promise.reject(new Error("unused"))),
  };
}

function signedIn(hosts: AccountHostMatch[], rejectedHostKeys: string[] = []): Extract<AccountState, { status: "signed-in" }> {
  return {
    status: "signed-in",
    mode: "cookie",
    user: "kieran",
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
    await userEvent.type(screen.getByLabelText("Email"), "kieran");
    await userEvent.type(await screen.findByLabelText("Password"), "pw{Enter}");
    expect(model.login).toHaveBeenCalledWith({ username: "kieran", password: "pw", serverOrigin: "https://app.pinomad.si" });
  });

  it("signs in to a self-hosted server once the user edits the address", async () => {
    const model = fakeModel({ status: "signed-out", mode: "bearer" });
    renderPanel(model);
    await userEvent.clear(screen.getByLabelText("Server"));
    await userEvent.type(screen.getByLabelText("Server"), "https://nomad.example");
    await userEvent.type(screen.getByLabelText("Email"), "kieran");
    await userEvent.type(await screen.findByLabelText("Password"), "pw{Enter}");
    expect(model.login).toHaveBeenCalledWith({ username: "kieran", password: "pw", serverOrigin: "https://nomad.example" });
  });

  it("prefills and submits the server address in bearer mode", async () => {
    const model = fakeModel({ status: "signed-out", mode: "bearer", serverOrigin: "https://nomad.example" });
    renderPanel(model);
    expect(screen.getByLabelText("Server")).toHaveValue("https://nomad.example");
    await userEvent.type(screen.getByLabelText("Email"), "kieran");
    await userEvent.type(await screen.findByLabelText("Password"), "pw{Enter}");
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

  it("signs out keeping the pairings unless the shared-computer box is ticked (#494)", async () => {
    const model = fakeModel(signedIn([]));
    renderPanel(model);
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    const shared = screen.getByRole("checkbox", { name: /shared computer/ });
    expect(shared).not.toBeChecked();
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(model.logout).toHaveBeenLastCalledWith({ revoke: false });

    await userEvent.click(shared);
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(model.logout).toHaveBeenLastCalledWith({ revoke: true });
  });

  it("warns when a shared-computer sign-out couldn't forget every host", async () => {
    const model = fakeModel(signedIn([]));
    model.logout = vi.fn(() => {
      model.setState({ status: "signed-out", mode: "cookie" });
      return Promise.resolve({ ok: false as const, error: { code: "hosts_not_forgotten" } });
    });
    renderPanel(model);
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await userEvent.click(screen.getByRole("checkbox", { name: /shared computer/ }));
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByText(/may still connect to them/)).toBeTruthy();
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

describe("Add a host (#496)", () => {
  it("shows the command without a token and the code entry, minting a token only under Advanced", async () => {
    const model = fakeModel(signedIn([]));
    renderPanel(model);
    await userEvent.click(screen.getByRole("button", { name: "Add a host" }));
    expect(screen.getByText(/sh -s -- up --origin https:\/\/nomad\.example/)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: /code/i })).toBeInTheDocument();
    expect(model.createJoinToken).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: /Advanced: join with a one-time token/ }));
    expect(model.createJoinToken).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("curl -fsSL https://pinomad.si/install.sh | sh -s -- join https://nomad.example join-1")).toBeInTheDocument();
  });
});

describe("account settings", () => {
  it("changes the password from the signed-in panel (#450)", async () => {
    const model = fakeModel(signedIn([]));
    renderPanel(model);
    await userEvent.click(await screen.findByRole("button", { name: "Change password" }));
    await userEvent.type(await screen.findByLabelText("Password"), "old password here");
    await userEvent.type(screen.getByLabelText("New password"), "new password here{Enter}");
    expect(model.changePassword).toHaveBeenCalledWith({ confirmation: "old password here", newPassword: "new password here" });
    expect(await screen.findByText("Password changed. Your other devices were signed out.")).toBeTruthy();
    expect(screen.queryByLabelText("Password")).toBeNull();
  });

  it("keeps the form and says so when the current password is wrong", async () => {
    const model = fakeModel(signedIn([]));
    vi.mocked(model.changePassword).mockResolvedValueOnce({ ok: false, error: { code: "wrong_password", status: 403 } });
    renderPanel(model);
    await userEvent.click(await screen.findByRole("button", { name: "Change password" }));
    await userEvent.type(screen.getByLabelText("Password"), "wrong one");
    await userEvent.type(screen.getByLabelText("New password"), "new password here{Enter}");
    expect(await screen.findByText("The password is wrong.")).toBeTruthy();
    expect(screen.getByLabelText("Password")).toBeTruthy();
  });

  it("deletes the account after the password and says the pairings stay (#451)", async () => {
    const model = fakeModel(signedIn([]));
    // The fake has no sign-out path of its own; land signed-out like the real model.
    vi.mocked(model.deleteAccount).mockImplementationOnce(() => {
      model.setState({ status: "signed-out", mode: "cookie" });
      return Promise.resolve({ ok: true, value: undefined });
    });
    renderPanel(model);
    await userEvent.click(screen.getByRole("button", { name: "Delete account" }));
    expect(screen.getByText(/run pinomad join on each/)).toBeTruthy();
    await userEvent.type(await screen.findByLabelText("Password"), "my password{Enter}");
    expect(model.deleteAccount).toHaveBeenCalledWith({ confirmation: "my password" });
    expect(await screen.findByText("Account deleted")).toBeTruthy();
    expect(screen.getByText(/still registered on your hosts/)).toBeTruthy();
    expect(screen.getByLabelText("Email")).toBeTruthy();
  });

  it("keeps the session and the form when the password is wrong", async () => {
    const model = fakeModel(signedIn([]));
    vi.mocked(model.deleteAccount).mockResolvedValueOnce({ ok: false, error: { code: "wrong_password", status: 403 } });
    renderPanel(model);
    await userEvent.click(screen.getByRole("button", { name: "Delete account" }));
    await userEvent.type(await screen.findByLabelText("Password"), "wrong one{Enter}");
    expect(await screen.findByText("The password is wrong.")).toBeTruthy();
    expect(screen.getByLabelText("Password")).toBeTruthy();
    expect(screen.getByText("kieran")).toBeTruthy();
  });

  it("drops the deletion notice on the next sign-in, so a later expiry doesn't repeat it", async () => {
    const model = fakeModel(signedIn([]));
    vi.mocked(model.deleteAccount).mockImplementationOnce(() => {
      model.setState({ status: "signed-out", mode: "cookie" });
      return Promise.resolve({ ok: true, value: undefined });
    });
    renderPanel(model);
    await userEvent.click(screen.getByRole("button", { name: "Delete account" }));
    await userEvent.type(await screen.findByLabelText("Password"), "my password{Enter}");
    expect(await screen.findByText("Account deleted")).toBeTruthy();
    act(() => model.setState({ ...signedIn([]), user: "bob" }));
    act(() => model.setState({ status: "signed-out", mode: "cookie" }));
    expect(screen.queryByText("Account deleted")).toBeNull();
  });

  it("says nothing when a deletion lands after signing in to another account", async () => {
    const model = fakeModel(signedIn([]));
    let answer!: () => void;
    vi.mocked(model.deleteAccount).mockImplementationOnce(
      () => new Promise((resolve) => (answer = () => resolve({ ok: true, value: undefined }))),
    );
    renderPanel(model);
    await userEvent.click(screen.getByRole("button", { name: "Delete account" }));
    await userEvent.type(await screen.findByLabelText("Password"), "my password{Enter}");
    act(() => model.setState({ status: "signed-out", mode: "cookie" }));
    act(() => model.setState({ ...signedIn([]), user: "bob" }));
    await act(async () => answer());
    act(() => model.setState({ status: "signed-out", mode: "cookie" }));
    expect(screen.queryByText("Account deleted")).toBeNull();
  });

});

describe("account devices (#452)", () => {
  const HOUR = 3_600_000;
  const DEVICES: AccountDevice[] = [
    { id: 1, name: "Mac Chrome", createdAt: 0, lastSeenAt: Date.now(), current: true, hosts: [] },
    {
      id: 2,
      name: "iPhone",
      createdAt: 0,
      lastSeenAt: Date.now() - 3 * HOUR,
      current: false,
      hosts: [
        { hostId: "h1", name: "omarchy", state: "registered" },
        { hostId: "h2", name: "studio", state: "revoking" },
      ],
    },
    { id: 3, createdAt: 0, lastSeenAt: Date.now() - 48 * HOUR, current: false, kickedAt: Date.now() - HOUR, hosts: [{ hostId: "h1", name: "omarchy", state: "revoked" }] },
  ];
  const withDevices = (devices: AccountDevice[], hosts: AccountHostMatch[] = []) => {
    const model = fakeModel(signedIn(hosts));
    vi.mocked(model.listDevices).mockResolvedValue({ ok: true, value: devices });
    return model;
  };
  const deviceRow = async (name: string) => (await screen.findByText(name)).closest("li")!;

  it("lists the account's devices with their state on each host; this device can't be removed", async () => {
    renderPanel(withDevices(DEVICES));
    const current = await deviceRow("Mac Chrome");
    expect(within(current).getByText("This device")).toBeTruthy();
    expect(within(current).queryByRole("button", { name: "Remove" })).toBeNull();
    const phone = row("iPhone");
    expect(within(phone).getByText(/Last sign-in 3h ago/)).toBeTruthy();
    expect(within(phone).getByText(/omarchy: registered/)).toBeTruthy();
    expect(within(phone).getByText(/studio: waiting for the host/)).toBeTruthy();
    expect(within(phone).getByRole("button", { name: "Remove" })).toBeTruthy();
    const unknown = row("Unknown device");
    expect(within(unknown).getByText("Removed")).toBeTruthy();
    expect(within(unknown).getByText(/omarchy: revoked/)).toBeTruthy();
    expect(within(unknown).queryByRole("button", { name: "Remove" })).toBeNull();
  });

  it("removes a device after the password and reloads the list", async () => {
    const plain = host({ name: "box" });
    const legacy = host({ name: "attic", hostId: "a".repeat(43), deviceReports: false });
    const model = withDevices(DEVICES, [
      { host: plain, status: "paired", stored: stored(KEY_A), linkable: false, autoRegister: false },
      { host: legacy, status: "unpaired", linkable: false, autoRegister: false },
    ]);
    renderPanel(model);
    await userEvent.click(within(await deviceRow("iPhone")).getByRole("button", { name: "Remove" }));
    expect(screen.getByText(/asks each host it joined through your account to revoke it/)).toBeTruthy();
    // Hosts that don't report devices can't be asked; the form names them.
    expect(screen.getByText(/attic can't be asked/)).toBeTruthy();
    await act(async () => {
      await userEvent.type(await screen.findByLabelText("Password"), "my password{Enter}");
    });
    expect(model.kickDevice).toHaveBeenCalledWith({ id: 2, confirmation: "my password" });
    expect(model.listDevices).toHaveBeenCalledTimes(2);
    expect(screen.queryByLabelText("Password")).toBeNull();
  });

  it("keeps the form when the password is wrong", async () => {
    const model = withDevices(DEVICES);
    vi.mocked(model.kickDevice).mockResolvedValueOnce({ ok: false, error: { code: "wrong_password", status: 403 } });
    renderPanel(model);
    await userEvent.click(within(await deviceRow("iPhone")).getByRole("button", { name: "Remove" }));
    await userEvent.type(await screen.findByLabelText("Password"), "wrong{Enter}");
    expect(await screen.findByText("The password is wrong.")).toBeTruthy();
    expect(screen.getByLabelText("Password")).toBeTruthy();
    expect(model.listDevices).toHaveBeenCalledTimes(1);
  });

  it("hides the section on a server that predates account devices", async () => {
    const model = fakeModel(signedIn([]));
    vi.mocked(model.listDevices).mockResolvedValue({ ok: false, error: { code: "not_found", status: 404 } });
    renderPanel(model);
    await act(async () => {});
    expect(screen.queryByText("Devices")).toBeNull();
  });
});

describe("removing a host (#512)", () => {
  const boxId = "h".repeat(43);
  const withHost = () =>
    fakeModel(signedIn([{ host: host({ name: "box", hostId: boxId }), status: "paired", stored: stored(KEY_A), linkable: false, autoRegister: false }]));

  it("removes a host after the password and says what that does", async () => {
    const model = withHost();
    renderPanel(model);
    await userEvent.click(within(row("box")).getByRole("button", { name: "Remove" }));
    expect(screen.getByText(/stops connecting through nomad\.example/)).toBeTruthy();
    expect(screen.getByText(/pinomad up/)).toBeTruthy();
    await act(async () => {
      await userEvent.type(await screen.findByLabelText("Password"), "my password{Enter}");
    });
    expect(model.removeHost).toHaveBeenCalledWith({ hostId: boxId, confirmation: "my password" });
    expect(screen.queryByLabelText("Password")).toBeNull();
  });

  it("keeps the form when the password is wrong", async () => {
    const model = withHost();
    vi.mocked(model.removeHost).mockResolvedValueOnce({ ok: false, error: { code: "wrong_password", status: 403 } });
    renderPanel(model);
    await userEvent.click(within(row("box")).getByRole("button", { name: "Remove" }));
    await userEvent.type(await screen.findByLabelText("Password"), "wrong{Enter}");
    expect(await screen.findByText("The password is wrong.")).toBeTruthy();
    expect(screen.getByLabelText("Password")).toBeTruthy();
  });

  it("says so when the server can't remove hosts", async () => {
    const model = withHost();
    vi.mocked(model.removeHost).mockResolvedValueOnce({ ok: false, error: { code: "remove_unsupported" } });
    renderPanel(model);
    await userEvent.click(within(row("box")).getByRole("button", { name: "Remove" }));
    await userEvent.type(await screen.findByLabelText("Password"), "pw{Enter}");
    expect(await screen.findByText(/pinomad leave/)).toBeTruthy();
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

describe("sign-in methods (ADR-0044 §4)", () => {
  const withMethods = (hasPassword: boolean, providers: readonly string[] = ["google", "github"]) => {
    const model = fakeModel({ ...signedIn([]), email: "kieran@example.com" });
    vi.mocked(model.identities).mockResolvedValue({
      ok: true,
      value: { hasPassword, identities: [{ provider: "github", email: "k@users.noreply.github.com", createdAt: 1 }] },
    });
    vi.mocked(model.authMethods).mockResolvedValue({ ok: true, value: { registration: true, email: true, providers } });
    return model;
  };

  it("lists the password and linked providers, and offers to link the rest", async () => {
    renderPanel(withMethods(true));
    const github = (await screen.findByText("GitHub")).closest("li")!;
    expect(within(github).getByText("k@users.noreply.github.com")).toBeTruthy();
    expect(within(row("Password")).getByRole("button", { name: "Change password" })).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Link Google" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Link GitHub" })).toBeNull();
  });

  it("offers no linking where the page can't go to the provider and back", async () => {
    renderPanel({ ...withMethods(true), providerFlow: undefined });
    await screen.findByText("GitHub");
    await act(async () => {});
    expect(screen.queryByRole("button", { name: /^Link / })).toBeNull();
  });

  it("links through the system browser on the desktop and lists the new provider (#631)", async () => {
    const model = { ...withMethods(true), providerFlow: "loopback" as const };
    vi.mocked(model.linkProvider).mockResolvedValueOnce({ ok: true, value: {} });
    renderPanel(model);
    await userEvent.click(await screen.findByRole("button", { name: "Link Google" }));
    await userEvent.type(await screen.findByLabelText("Password"), "pw");
    await userEvent.click(screen.getByRole("button", { name: "Continue to Google" }));
    expect(model.linkProvider).toHaveBeenCalledWith("google", "pw");
    expect(await screen.findByText("Google linked.")).toBeTruthy();
    expect(vi.mocked(model.identities).mock.calls.length).toBeGreaterThan(1);
  });

  it("drops a desktop link that finishes after Cancel, keeping the form opened since (dureview #635)", async () => {
    const model = { ...withMethods(true), providerFlow: "loopback" as const };
    let finish!: () => void;
    vi.mocked(model.linkProvider).mockReturnValueOnce(new Promise((resolve) => (finish = () => resolve({ ok: true, value: {} }))));
    renderPanel(model);
    await userEvent.click(await screen.findByRole("button", { name: "Link Google" }));
    await userEvent.type(await screen.findByLabelText("Password"), "pw");
    await userEvent.click(screen.getByRole("button", { name: "Continue to Google" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await userEvent.click(within(row("Password")).getByRole("button", { name: "Change password" }));
    await userEvent.type(await screen.findByLabelText("New password"), "half-typed");
    await act(async () => finish());
    expect((screen.getByLabelText("New password") as HTMLInputElement).value).toBe("half-typed");
    expect(screen.queryByText("Google linked.")).toBeNull();
  });

  it("says so when removing the last way in", async () => {
    const model = withMethods(false);
    vi.mocked(model.unlinkProvider).mockResolvedValueOnce({ ok: false, error: { code: "last_method", status: 409 } });
    renderPanel(model);
    expect(within((await screen.findByText("Password")).closest("li")!).getByText("Not set")).toBeTruthy();
    await userEvent.click(within((await screen.findByText("GitHub")).closest("li")!).getByRole("button", { name: "Remove" }));
    // No password: the confirmation is a mailed code.
    await userEvent.click(await screen.findByRole("button", { name: "Send code" }));
    await userEvent.type(await screen.findByLabelText("Confirmation code"), "123456");
    await userEvent.click(screen.getByRole("button", { name: "Remove GitHub" }));
    expect(model.reauth).toHaveBeenCalledWith({ code: "123456" });
    expect(model.unlinkProvider).toHaveBeenCalledWith("github", { reauth: "grant" });
    expect(await screen.findByText(accountErrorMessage({ code: "last_method" }))).toBeTruthy();
  });

  it("kicks a device on an account without a password with a mailed code", async () => {
    const model = withMethods(false);
    vi.mocked(model.listDevices).mockResolvedValue({
      ok: true,
      value: [{ id: 2, name: "iPhone", createdAt: 0, lastSeenAt: Date.now(), current: false, hosts: [] }],
    });
    renderPanel(model);
    await userEvent.click(within((await screen.findByText("iPhone")).closest("li")!).getByRole("button", { name: "Remove" }));
    expect(await screen.findByText("We'll email a code to kieran@example.com.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Send code" }));
    await userEvent.type(await screen.findByLabelText("Confirmation code"), "123456{Enter}");
    await vi.waitFor(() => expect(model.kickDevice).toHaveBeenCalledWith({ id: 2, confirmation: { reauth: "grant" } }));
  });
});
