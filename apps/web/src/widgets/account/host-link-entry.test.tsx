// Confirming a host that ran `pinomad join <origin>` without a token (#496):
// the code is typed here, never taken from the address, and the confirm page
// says which machine is asking before anything is sent.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountResult, HostLinkRequest } from "@pinomad/client/account.ts";
import { AccountContext } from "../../entities/account/account-context.tsx";
import type { AccountModel } from "../../entities/account/account-model.ts";
import { createKnownHostsStore } from "../../entities/account/known-hosts.ts";
import { fakeAccount, signedIn } from "../../test/story-fixtures.tsx";
import { HostLinkEntry } from "./host-link-entry.tsx";

const request = (overrides: Partial<HostLinkRequest> = {}): HostLinkRequest => ({
  hostId: "Or-983sVxD715Pir-F61GmSkh4kPJVn1RvqZkt9MnSA",
  name: "e2e-mbp",
  os: "macOS 26.1",
  sourceIp: "203.0.113.7",
  ipDiffers: false,
  expiresAt: Date.now() + 9 * 60_000,
  ...overrides,
});

const ok = <T,>(value: T): Promise<AccountResult<T>> => Promise.resolve({ ok: true, value });
const fail = (code: string, status?: number): Promise<AccountResult<never>> =>
  Promise.resolve({ ok: false, error: { code, ...(status === undefined ? {} : { status }) } });

function model(actions: Partial<AccountModel> = {}): AccountModel {
  return {
    ...fakeAccount(signedIn()),
    lookupHostLink: vi.fn(() => ok(request())),
    confirmHostLink: vi.fn(() => ok(undefined)),
    denyHostLink: vi.fn(() => ok(undefined)),
    refreshHosts: vi.fn(() => ok([])),
    ...actions,
  };
}

const renderEntry = (account: AccountModel, props: Parameters<typeof HostLinkEntry>[0] = {}) =>
  render(
    <AccountContext.Provider value={account}>
      <HostLinkEntry {...props} />
    </AccountContext.Provider>,
  );

const codeInput = () => screen.getByRole("textbox", { name: /code/i });

async function lookUp(code = "kxhn bwcv") {
  const user = userEvent.setup();
  await user.type(codeInput(), code);
  await user.click(screen.getByRole("button", { name: "Continue" }));
  return user;
}

beforeEach(() => localStorage.clear());
afterEach(() => window.history.replaceState(null, "", "/"));

describe("HostLinkEntry", () => {
  it("formats the typed code and looks it up as XXXX-XXXX", async () => {
    const account = model();
    renderEntry(account);
    const user = userEvent.setup();
    await user.type(codeInput(), "kxhn bwcv");
    expect(codeInput()).toHaveValue("KXHN-BWCV");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(account.lookupHostLink).toHaveBeenCalledWith("KXHN-BWCV");
  });

  it("waits for all eight letters before it asks", async () => {
    const account = model();
    renderEntry(account);
    await userEvent.setup().type(codeInput(), "KXHNBWC");
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
  });

  it("never takes the code from the address", async () => {
    window.history.replaceState(null, "", "/host-link?code=KXHNBWCV&userCode=KXHN-BWCV#KXHN-BWCV");
    const account = model();
    renderEntry(account);
    expect(codeInput()).toHaveValue("");
    expect(account.lookupHostLink).not.toHaveBeenCalled();
  });

  it("shows which machine is asking before offering Confirm", async () => {
    renderEntry(model());
    await lookUp();
    expect(await screen.findByText("e2e-mbp")).toBeInTheDocument();
    expect(screen.getByText("macOS 26.1")).toBeInTheDocument();
    expect(screen.getByText("203.0.113.7")).toBeInTheDocument();
    expect(screen.getByText("Only confirm a computer you are setting up yourself right now.")).toBeInTheDocument();
    // The full id stays reachable behind the shortened fingerprint.
    expect(screen.getByLabelText("Host ID Or-983sVxD715Pir-F61GmSkh4kPJVn1RvqZkt9MnSA")).toBeInTheDocument();
    expect(screen.queryByText(/different network address/)).toBeNull();
  });

  it("warns when the host asked from another address than this device", async () => {
    renderEntry(model({ lookupHostLink: vi.fn(() => ok(request({ ipDiffers: true }))) }));
    await lookUp();
    expect(await screen.findByText(/different network address/)).toBeInTheDocument();
  });

  it.each([
    ["not_found", 404, /No host is waiting with this code/],
    ["rate_limited", 429, /Too many wrong codes/],
    ["network", undefined, /Can't reach the server/],
  ])("says what a %s lookup means", async (code, status, message) => {
    renderEntry(model({ lookupHostLink: vi.fn(() => fail(code, status)) }));
    await lookUp();
    expect(await screen.findByText(message)).toBeInTheDocument();
    // Still on the entry, with the code kept for another try.
    expect(codeInput()).toHaveValue("KXHN-BWCV");
  });

  it("confirms, refreshes the hosts and remembers the host so this device doesn't announce it", async () => {
    const knownHosts = createKnownHostsStore(localStorage);
    const account = { serverOrigin: "https://pinomad.si", user: "kieran" };
    knownHosts.arrivals(account, []);
    const model_ = model();
    const onSettled = vi.fn();
    renderEntry(model_, { knownHosts, onSettled });
    const user = await lookUp();
    await user.click(await screen.findByRole("button", { name: "Confirm" }));
    expect(model_.confirmHostLink).toHaveBeenCalledWith("KXHN-BWCV");
    expect(await screen.findByText(/will appear in your hosts and connect on its own/)).toBeInTheDocument();
    expect(model_.refreshHosts).toHaveBeenCalled();
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(knownHosts.arrivals(account, [request().hostId])).toEqual([]);
  });

  it("denies and says the host was turned away", async () => {
    const account = model();
    const onSettled = vi.fn();
    renderEntry(account, { onSettled });
    const user = await lookUp();
    await user.click(await screen.findByRole("button", { name: "Deny" }));
    expect(account.denyHostLink).toHaveBeenCalledWith("KXHN-BWCV");
    expect(await screen.findByText(/Turned e2e-mbp away/)).toBeInTheDocument();
    expect(account.confirmHostLink).not.toHaveBeenCalled();
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("explains a request that went away between lookup and confirm", async () => {
    const onSettled = vi.fn();
    renderEntry(model({ confirmHostLink: vi.fn(() => fail("not_found", 404)) }), { onSettled });
    const user = await lookUp();
    await user.click(await screen.findByRole("button", { name: "Confirm" }));
    expect(await screen.findByText(/no longer waiting/)).toBeInTheDocument();
    expect(onSettled).not.toHaveBeenCalled();
  });

  it("won't confirm a request whose code has expired", async () => {
    renderEntry(model({ lookupHostLink: vi.fn(() => ok(request({ expiresAt: Date.now() - 1 }))) }));
    await lookUp();
    expect(await screen.findByText(/This code has expired/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm" })).toBeDisabled();
  });

  it("goes back to the entry from the confirm page", async () => {
    const account = model();
    renderEntry(account);
    const user = await lookUp();
    await user.click(await screen.findByRole("button", { name: "Enter another code" }));
    expect(codeInput()).toHaveValue("");
    expect(account.denyHostLink).not.toHaveBeenCalled();
  });
});
