// Settings → This Mac (#501): the switch shows the installed service's real
// state, turning it off goes through a confirm, and a stop waiting on tasks
// can be cancelled — which leaves the host on.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountContext } from "../../entities/account/account-context.tsx";
import type { AccountState } from "../../entities/account/account-model.ts";
import type { DesktopBridge } from "../../entities/host/desktop-bridge.ts";
import type { LocalHostState } from "../../entities/local-host/local-host-protocol.ts";
import { fakeAccount, fakeLocalHost, signedIn, type FakeLocalHostOptions } from "../../test/story-fixtures.tsx";
import { LocalHostSection } from "./local-host-section.tsx";

const running: LocalHostState = { kind: "installed", running: true, stopped: false, stopping: false, detail: "running (pid 4242)" };
const off: LocalHostState = { kind: "installed", running: false, stopped: true, stopping: false, detail: "stopped" };

afterEach(() => {
  delete window.pinomadDesktop;
});

function renderSection(options: FakeLocalHostOptions, account: AccountState = signedIn()) {
  const localHost = fakeLocalHost(options);
  window.pinomadDesktop = { localHost } as unknown as DesktopBridge;
  const wrap = ({ children }: { children: ReactNode }) => (
    <AccountContext.Provider value={fakeAccount(account)}>{children}</AccountContext.Provider>
  );
  render(<LocalHostSection pollIntervalMs={10} />, { wrapper: wrap });
  return { localHost, user: userEvent.setup() };
}

const hostSwitch = () => screen.findByRole("switch", { name: /Run the host on this Mac/ });

describe("LocalHostSection", () => {
  it("shows the service's real state and turns it on through service start", async () => {
    const { localHost, user } = renderSection({ state: off });
    expect(await hostSwitch()).not.toBeChecked();

    await user.click(await hostSwitch());

    expect(localHost.start).toHaveBeenCalledTimes(1);
    await waitFor(async () => expect(await hostSwitch()).toBeChecked());
  });

  it("stays on, and can be turned off, while a crashed host waits for launchd to restart it", async () => {
    const { localHost, user } = renderSection({
      state: { kind: "installed", running: false, stopped: false, stopping: false, detail: "spawn scheduled, last exit 1" },
    });
    expect(await hostSwitch()).toBeChecked();

    await user.click(await hostSwitch());
    await user.click(await screen.findByRole("button", { name: "Turn off" }));

    expect(localHost.start).not.toHaveBeenCalled();
    expect(localHost.stop).toHaveBeenCalledTimes(1);
    await waitFor(async () => expect(await hostSwitch()).not.toBeChecked());
  });

  it("asks before turning off, and backing out of the dialog stops nothing", async () => {
    const { localHost, user } = renderSection({ state: running });
    await user.click(await hostSwitch());

    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    expect(localHost.stop).not.toHaveBeenCalled();
    expect(await hostSwitch()).toBeChecked();
  });

  it("turns off after the confirm once the CLI finishes", async () => {
    const { localHost, user } = renderSection({ state: running });
    await user.click(await hostSwitch());
    await user.click(await screen.findByRole("button", { name: "Turn off" }));

    expect(localHost.stop).toHaveBeenCalledTimes(1);
    await waitFor(async () => expect(await hostSwitch()).not.toBeChecked());
  });

  it("shows the task lines while stopping, and Cancel leaves the host on", async () => {
    const { localHost, user } = renderSection({
      state: running,
      stopLines: ["waiting for running tasks to finish", "  refactor-auth: running"],
      stopWaits: true,
    });
    await user.click(await hostSwitch());
    await user.click(await screen.findByRole("button", { name: "Turn off" }));

    const log = await screen.findByRole("log");
    await waitFor(() => expect(log).toHaveTextContent("refactor-auth: running"));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(localHost.cancelStop).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("log")).not.toBeInTheDocument());
    expect(await hostSwitch()).toBeChecked();
    expect(screen.getByRole("switch")).toBeEnabled();
  });

  it("picks a stop that is still waiting back up, with its lines and Cancel, when This Mac opens again", async () => {
    const { localHost, user } = renderSection({
      state: running,
      stopLines: ["waiting for running tasks to finish", "  refactor-auth: running"],
      stopWaits: true,
      stopInFlight: true,
    });

    const log = await screen.findByRole("log");
    await waitFor(() => expect(log).toHaveTextContent("refactor-auth: running"));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(localHost.cancelStop).toHaveBeenCalledTimes(1);
    expect(localHost.stop).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("log")).not.toBeInTheDocument());
    expect(await hostSwitch()).toBeChecked();
    expect(screen.getByRole("switch")).toBeEnabled();
  });

  it("puts a failed start in a banner and keeps the switch off", async () => {
    const { user } = renderSection({ state: off, startResult: { ok: false, message: "launchctl bootstrap failed: 5" } });
    await user.click(await hostSwitch());

    expect(await screen.findByText("launchctl bootstrap failed: 5")).toBeInTheDocument();
    expect(await hostSwitch()).not.toBeChecked();
  });

  it("offers Run in Terminal for this account's server when nothing is installed, then the code field", async () => {
    const account = signedIn();
    const { localHost, user } = renderSection({ state: { kind: "not-installed" } }, account);

    await user.click(await screen.findByRole("button", { name: "Run in Terminal" }));

    expect(localHost.runSetup).toHaveBeenCalledWith((account as Extract<AccountState, { status: "signed-in" }>).serverOrigin);
    expect(await screen.findByRole("textbox")).toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });

  it("shows the switch once the host confirmed here finishes installing", async () => {
    const { localHost, user } = renderSection({ state: { kind: "not-installed" } });
    await user.click(await screen.findByRole("button", { name: "Run in Terminal" }));
    await user.type(await screen.findByRole("textbox"), "kxhn bwcv");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(await screen.findByRole("button", { name: "Confirm" }));
    await screen.findByText(/joined your account/);

    // `pinomad up` installs the service only after the code is confirmed,
    // writing its definition a moment before launchd starts it.
    const loading: LocalHostState = { kind: "installed", running: false, stopped: false, stopping: false, detail: "not loaded" };
    vi.mocked(localHost.state).mockResolvedValueOnce(loading).mockResolvedValue(running);
    expect(await hostSwitch()).toBeChecked();
    // It keeps reading until the host is up, not just until it is installed.
    expect(await screen.findByText("running (pid 4242)")).toBeInTheDocument();
  });

  it("shows no switch for a host too old to report its state", async () => {
    renderSection({ state: { kind: "too-old" } });
    expect(await screen.findByText(/pinomad upgrade/)).toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });
});
