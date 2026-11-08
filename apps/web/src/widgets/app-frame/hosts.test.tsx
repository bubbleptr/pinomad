// jsdom: the Hosts page. One list for every machine: the ones paired here,
// then the account's others, each row offering at most one action; the
// connection and unpairing live on the host's own page.
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { AccountHost, AccountHostMatch } from "@pinomad/client/account.ts";
import type { StoredHost } from "@pinomad/client/stored-host.ts";
import type { RtcDiagnostics } from "@pinomad/protocol/remote-durable.ts";
import type { DurableView } from "@pinomad/protocol/view.ts";
import { DEVBOX_HOST, HOME_HOST, fakeAccount, fakeHosts, fakeRemote, fakeView, signedIn } from "../../test/story-fixtures.tsx";
import { AccountContext } from "../../entities/account/account-context.tsx";
import type { AccountModel, AccountState } from "../../entities/account/account-model.ts";
import { HostComposerStore } from "../../entities/composer/composer-store.ts";
import {
  createHostRuntimeRegistry,
  HostRuntimesContext,
  type HostRuntimeInfo,
} from "../../entities/host/host-runtimes.ts";
import { HostsContext, type HostsState } from "../../entities/host/host-store.ts";
import { HostsSection } from "./hosts.tsx";

const diagnostics: RtcDiagnostics = { path: "relay", phase: "active", cooldownRemainingMs: 0 };

function accountHost(overrides: Partial<AccountHost>): AccountHost {
  return { hostId: "h".repeat(43), name: "box", noisePublicKey: HOME_HOST.hostKey, online: true, lastSeenAt: Date.now(), pairing: "available", ...overrides };
}

const linked = (host: StoredHost, hostId: string): StoredHost => ({ ...host, account: { serverOrigin: "https://pinomad.si", hostId } });

function harness({
  connection = "connected",
  connectionMode,
  withRuntime = true,
  hosts = [HOME_HOST],
  account,
}: {
  connection?: DurableView["connection"];
  connectionMode?: "auto" | "directOnly" | "relayOnly";
  withRuntime?: boolean;
  hosts?: readonly StoredHost[];
  account?: AccountModel;
} = {}) {
  const setConnection = vi.fn(async () => {});
  const forget = vi.fn(async () => {});
  const stored = hosts.map((host, index) =>
    index === 0 && connectionMode !== undefined ? { ...host, connectionMode } : host,
  );
  const state: HostsState = { ...fakeHosts(stored, stored[0]?.hostKey ?? null), setConnection, forget };
  const retry = vi.fn();
  const view = fakeView({ connection, host: { version: "0.9.0", protocol: { major: 5, minor: 23, patch: 0 } } } as never);
  const remote = {
    ...fakeRemote(view),
    rtcDiagnostics: () => diagnostics,
    setConnectionMode: vi.fn(),
  };
  const registry = createHostRuntimeRegistry();
  if (withRuntime && stored[0] !== undefined) {
    const info: HostRuntimeInfo = { phase: "ready", remote, view, retry, composer: new HostComposerStore() };
    registry.publish(stored[0].hostKey, info);
  }
  const section = (
    <HostsContext.Provider value={state}>
      <HostRuntimesContext.Provider value={registry}>
        <HostsSection rtcAvailable />
      </HostRuntimesContext.Provider>
    </HostsContext.Provider>
  );
  render(account === undefined ? section : <AccountContext.Provider value={account}>{section}</AccountContext.Provider>);
  return { setConnection, forget, remote, retry };
}

const paired = () => screen.getByRole("list", { name: "Paired with this device" });
const onAccount = () => screen.getByRole("list", { name: "On your account" });
const row = (list: HTMLElement, name: string) => within(list).getByText(name).closest("li")!;

async function openDetails(label: string): Promise<void> {
  await userEvent.click(screen.getByRole("button", { name: `${label} details` }));
}

async function choose(mode: "Auto" | "Direct only" | "Relay only"): Promise<void> {
  await openDetails(HOME_HOST.name!);
  await userEvent.click(screen.getByRole("radio", { name: mode }));
}

describe("HostsSection connection mode", () => {
  it("switches the connected host's mode and reconnects it", async () => {
    const { setConnection, remote } = harness({ connection: "connected" });
    await choose("Relay only");
    await waitFor(() => expect(setConnection).toHaveBeenCalledWith(HOME_HOST.hostKey, { connectionMode: "relayOnly" }));
    await waitFor(() => expect(remote.setConnectionMode).toHaveBeenCalledWith("relayOnly"));
  });

  it("remounts a terminal coordinator instead of asking it to switch modes", async () => {
    const { setConnection, remote, retry } = harness({ connection: "closed", connectionMode: "directOnly" });
    await choose("Auto");
    await waitFor(() => expect(setConnection).toHaveBeenCalledWith(HOME_HOST.hostKey, { connectionMode: "auto" }));
    await waitFor(() => expect(retry).toHaveBeenCalledTimes(1));
    expect(remote.setConnectionMode).not.toHaveBeenCalled();
  });

  it("persists a host with no ready coordinator without touching another host", async () => {
    const { setConnection, remote, retry } = harness({ connection: "connected", withRuntime: false });
    await choose("Direct only");
    await waitFor(() =>
      expect(setConnection).toHaveBeenCalledWith(HOME_HOST.hostKey, { connectionMode: "directOnly" }),
    );
    expect(remote.setConnectionMode).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
  });
});

describe("HostsSection unpairing", () => {
  it("unpairs from the host's page only after the dialog confirms it", async () => {
    const { forget } = harness({ hosts: [HOME_HOST, DEVBOX_HOST], withRuntime: false });
    await openDetails(DEVBOX_HOST.name!);
    await userEvent.click(screen.getByRole("button", { name: "Unpair" }));
    const dialog = screen.getByRole("dialog", { name: `Unpair ${DEVBOX_HOST.name}?` });
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(forget).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Unpair" }));
    await userEvent.click(within(screen.getByRole("dialog", { name: `Unpair ${DEVBOX_HOST.name}?` })).getByRole("button", { name: "Unpair" }));
    await waitFor(() => expect(forget).toHaveBeenCalledWith(DEVBOX_HOST.hostKey));
    // Back on the list, which no longer needs the host's page.
    expect(await screen.findByRole("list", { name: "Paired with this device" })).toBeTruthy();
  });
});

describe("HostsSection with an account", () => {
  const model = (state: AccountState, actions: Partial<AccountModel> = {}): AccountModel => ({ ...fakeAccount(state), ...actions });

  it("lists the account's other hosts apart, offering Pair only where the server says it can", () => {
    harness({
      account: model(
        signedIn({
          hosts: [
            { host: accountHost({ name: "kieran-mbp" }), status: "paired", stored: HOME_HOST, linkable: false, autoRegister: false },
            { host: accountHost({ name: "up", hostId: "u".repeat(43), noisePublicKey: "U".repeat(43) }), status: "unpaired", linkable: false, autoRegister: true },
            { host: accountHost({ name: "down", hostId: "d".repeat(43), noisePublicKey: "D".repeat(43), online: false, pairing: "offline" }), status: "unpaired", linkable: false, autoRegister: true },
            { host: accountHost({ name: "old", hostId: "o".repeat(43), noisePublicKey: "O".repeat(43), pairing: "host_too_old" }), status: "unpaired", linkable: false, autoRegister: true },
          ],
        }),
      ),
    });
    expect(within(paired()).getByText("kieran-mbp")).toBeTruthy();
    expect(within(onAccount()).queryByText("kieran-mbp")).toBeNull();
    expect(within(row(onAccount(), "up")).getByRole("button", { name: "Pair" })).toBeEnabled();
    expect(within(row(onAccount(), "down")).queryByRole("button", { name: "Pair" })).toBeNull();
    expect(within(row(onAccount(), "old")).queryByRole("button", { name: "Pair" })).toBeNull();
    expect(within(row(onAccount(), "old")).getByText(/pinomad upgrade/)).toBeTruthy();
  });

  it("shows no account section when every account host is paired here", () => {
    harness({
      account: model(signedIn({ hosts: [{ host: accountHost({}), status: "paired", stored: HOME_HOST, linkable: false, autoRegister: false }] })),
    });
    expect(screen.queryByRole("list", { name: "On your account" })).toBeNull();
  });

  it("asks before re-pairing a host whose identity changed, on the paired row", async () => {
    const pairHost = vi.fn(async () => ({ ok: false as const, error: { code: "host_timeout" } }));
    const stale = linked(HOME_HOST, "h".repeat(43));
    harness({
      hosts: [stale],
      account: model(
        signedIn({ hosts: [{ host: accountHost({ noisePublicKey: "B".repeat(43) }), status: "key_changed", stored: stale, linkable: false, autoRegister: false }] }),
        { pairHost },
      ),
    });
    const hostRow = row(paired(), HOME_HOST.name!);
    expect(within(hostRow).getByText(/identity changed/i)).toBeTruthy();
    expect(pairHost).not.toHaveBeenCalled();
    await userEvent.click(within(hostRow).getByRole("button", { name: "Pair again" }));
    expect(pairHost).toHaveBeenCalledWith("h".repeat(43));
    // The pairing failure surfaces in words, not as a code.
    expect(await screen.findByText(/didn't answer in time/)).toBeTruthy();
  });

  it("offers a re-pair on a paired host that refused this device", () => {
    harness({
      account: model(
        signedIn({
          hosts: [{ host: accountHost({}), status: "paired", stored: HOME_HOST, linkable: false, autoRegister: false }],
          rejectedHostKeys: [HOME_HOST.hostKey],
        }),
      ),
    });
    const hostRow = row(paired(), HOME_HOST.name!);
    expect(within(hostRow).getByText(/refused this device/)).toBeTruthy();
    expect(within(hostRow).getByRole("button", { name: "Pair again" })).toBeEnabled();
  });

  it("focuses an account host once it pairs", async () => {
    const pairHost = vi.fn(async () => ({ ok: true as const, value: { ...DEVBOX_HOST } }));
    const hosts = fakeHosts([HOME_HOST], HOME_HOST.hostKey);
    const focusHost = vi.fn();
    const account = model(
      signedIn({ hosts: [{ host: accountHost({ name: "up", hostId: "u".repeat(43), noisePublicKey: DEVBOX_HOST.hostKey }), status: "unpaired", linkable: false, autoRegister: true }] }),
      { pairHost },
    );
    render(
      <HostsContext.Provider value={{ ...hosts, focusHost }}>
        <AccountContext.Provider value={account}>
          <HostsSection rtcAvailable />
        </AccountContext.Provider>
      </HostsContext.Provider>,
    );
    await act(async () => {
      await userEvent.click(within(row(onAccount(), "up")).getByRole("button", { name: "Pair" }));
    });
    expect(pairHost).toHaveBeenCalledWith("u".repeat(43));
    expect(focusHost).toHaveBeenCalledWith(DEVBOX_HOST.hostKey);
  });

  it("removes an account host after the password, from the row's menu", async () => {
    const removeHost = vi.fn(async () => ({ ok: true as const, value: undefined }));
    const match: AccountHostMatch = { host: accountHost({ name: "up", hostId: "u".repeat(43), noisePublicKey: "U".repeat(43) }), status: "unpaired", linkable: false, autoRegister: true };
    harness({ account: model(signedIn({ hosts: [match] }), { removeHost }) });
    await userEvent.click(within(row(onAccount(), "up")).getByRole("button", { name: "More for up" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Remove from account" }));
    const dialog = screen.getByRole("dialog", { name: "Remove up" });
    expect(within(dialog).getByText(/stops connecting through pinomad\.si/)).toBeTruthy();
    await act(async () => {
      await userEvent.type(await within(dialog).findByLabelText("Password"), "my password{Enter}");
    });
    expect(removeHost).toHaveBeenCalledWith({ hostId: "u".repeat(43), confirmation: "my password" });
  });

  it("moves an unpaired account host to the account's section before the next refresh (dureview #641)", async () => {
    const home = linked(HOME_HOST, "h".repeat(43));
    const devbox = linked(DEVBOX_HOST, "d".repeat(43));
    // The account's verdicts as of the last refresh: both paired here.
    const account = model(
      signedIn({
        hosts: [
          { host: accountHost({ name: "kieran-mbp" }), status: "paired", stored: home, linkable: false, autoRegister: false },
          { host: accountHost({ name: "omarchy", hostId: "d".repeat(43), noisePublicKey: DEVBOX_HOST.hostKey }), status: "paired", stored: devbox, linkable: false, autoRegister: false },
        ],
      }),
    );
    function Live() {
      const [hosts, setHosts] = useState<readonly StoredHost[]>([home, devbox]);
      const state: HostsState = {
        ...fakeHosts(hosts, HOME_HOST.hostKey),
        forget: async (hostKey) => setHosts((list) => list.filter((each) => each.hostKey !== hostKey)),
      };
      return (
        <HostsContext.Provider value={state}>
          <AccountContext.Provider value={account}>
            <HostsSection rtcAvailable />
          </AccountContext.Provider>
        </HostsContext.Provider>
      );
    }
    render(<Live />);
    await openDetails("omarchy");
    await userEvent.click(screen.getByRole("button", { name: "Unpair" }));
    await userEvent.click(within(screen.getByRole("dialog", { name: "Unpair omarchy?" })).getByRole("button", { name: "Unpair" }));
    expect(within(await screen.findByRole("list", { name: "On your account" })).getByText("omarchy")).toBeTruthy();
    expect(within(paired()).queryByText("omarchy")).toBeNull();
  });

  it("refreshes the account's hosts once when the page opens", () => {
    const refreshHosts = vi.fn(async () => ({ ok: true as const, value: [] }));
    harness({ account: model(signedIn({ hosts: [] }), { refreshHosts }) });
    expect(refreshHosts).toHaveBeenCalledTimes(1);
  });
});
