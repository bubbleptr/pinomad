// Settings → Upgrade (ADR-0043): which actions a host's `upgrade` state offers
// and which calls they make. The fake remote's spies stand in for the host.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostUpgrade } from "@pinomad/protocol/upgrade.ts";
import { fakeRemote, fakeUpgrade, fakeView } from "../../test/story-fixtures.tsx";
import { Toaster } from "../../shared/ui/toast.tsx";
import { CALL_TIMEOUT_MS, HostUpgradeSection } from "./host-upgrade-section.tsx";

afterEach(() => vi.useRealTimers());

function renderSection(
  upgrade: Partial<HostUpgrade> = {},
  overrides: Parameters<typeof fakeView>[0] = {},
  controller: Parameters<typeof fakeRemote>[1] = {},
) {
  const view = fakeView({ upgrade: fakeUpgrade(upgrade), ...overrides });
  const remote = fakeRemote(view, controller);
  render(<HostUpgradeSection view={view} remote={remote} />);
  return { remote, user: userEvent.setup() };
}

describe("HostUpgradeSection", () => {
  it("upgrades when idle after the confirmation", async () => {
    const { remote, user } = renderSection();
    await user.click(screen.getByRole("button", { name: "Upgrade" }));
    await user.click(screen.getByRole("button", { name: "Upgrade when idle" }));
    expect(remote.controller.startUpgrade).toHaveBeenCalledWith("idle");
  });

  it("warns in the confirmation when the release crosses a protocol major", async () => {
    const { user } = renderSection({ available: { version: "1.0.0", publishedAt: Date.now(), crossesMajor: true } });
    await user.click(screen.getByRole("button", { name: "Upgrade" }));
    const confirm = screen.getByRole("dialog", { name: "Upgrade the host to pinomad 1.0.0?" });
    expect(confirm).toHaveTextContent("Apps that haven't updated yet can't connect");
    expect(confirm).toHaveTextContent("Open terminals close");
  });

  it("closes the confirmation when another device starts the upgrade", async () => {
    const view = fakeView({ upgrade: fakeUpgrade() });
    const remote = fakeRemote(view);
    const { rerender } = render(<HostUpgradeSection view={view} remote={remote} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Upgrade" }));
    expect(screen.getByRole("dialog", { name: /Upgrade the host/ })).toBeInTheDocument();
    const waiting = fakeView({ upgrade: fakeUpgrade({ phase: "waiting", target: "0.14.0" }) });
    rerender(<HostUpgradeSection view={waiting} remote={remote} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    // Cancelled again elsewhere, the dialog stays closed.
    rerender(<HostUpgradeSection view={view} remote={remote} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("cancels a wait", async () => {
    const { remote, user } = renderSection({ phase: "waiting", target: "0.14.0" });
    expect(screen.queryByRole("button", { name: "Upgrade" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Cancel upgrade" }));
    expect(remote.controller.cancelUpgrade).toHaveBeenCalled();
  });

  it("offers no actions while installing", () => {
    renderSection({ phase: "installing", target: "0.14.0" });
    expect(screen.getByText(/Installing pinomad 0.14.0/)).toBeInTheDocument();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("keeps the confirmation until the host answers, and says so when it doesn't", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { user } = renderSection({}, {}, { startUpgrade: () => new Promise(() => {}) });
    await user.click(screen.getByRole("button", { name: "Upgrade" }));
    await user.click(screen.getByRole("button", { name: "Upgrade when idle" }));
    expect(screen.getByRole("dialog", { name: /Upgrade the host/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await act(async () => {
      vi.advanceTimersByTime(CALL_TIMEOUT_MS);
    });
    expect(await screen.findByText(/The host didn't answer/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  });

  it("still reports a start that fails after its confirmation closed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const view = fakeView({ upgrade: fakeUpgrade() });
    const remote = fakeRemote(view, { startUpgrade: () => new Promise(() => {}) });
    const { rerender } = render(<Toaster><HostUpgradeSection view={view} remote={remote} /></Toaster>);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Upgrade" }));
    await user.click(screen.getByRole("button", { name: "Upgrade when idle" }));
    // The host drops: the confirmation closes before the call times out.
    rerender(<Toaster><HostUpgradeSection view={{ ...view, connection: "reconnecting" }} remote={remote} /></Toaster>);
    expect(screen.queryByRole("dialog")).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(CALL_TIMEOUT_MS);
    });
    await waitFor(() => expect(document.querySelector("[data-toast-id]")).toHaveTextContent(/Couldn't start the upgrade: The host didn't answer/));
  });

  it("doesn't call a failed check up to date", () => {
    renderSection({ available: null, checkError: "getaddrinfo ENOTFOUND registry.npmjs.org" });
    expect(screen.queryByText(/Up to date/)).toBeNull();
    expect(screen.getByText("Couldn't check for releases")).toBeInTheDocument();
  });

  it("tells a source checkout how to upgrade, without a check it can't run", () => {
    renderSection({ current: null, blocked: "source", available: null, checkedAt: null });
    expect(screen.getByText(/bun run upgrade/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Check now" })).toBeNull();
  });

  it("shows the command instead of the button when the host can't upgrade itself", () => {
    renderSection({ blocked: "no-service" });
    expect(screen.queryByRole("button", { name: "Upgrade" })).toBeNull();
    expect(screen.getByText(/Run `pinomad upgrade` on the host/)).toBeInTheDocument();
  });

  it("shows the last failure with npm's output", () => {
    renderSection({ failure: { version: "0.14.0", attempt: 1, message: "npm ERR! code EACCES" } });
    expect(screen.getByText("Upgrading to pinomad 0.14.0 failed")).toBeInTheDocument();
    expect(screen.getByText("npm ERR! code EACCES")).toBeInTheDocument();
  });

  it("checks now", async () => {
    const { remote, user } = renderSection({ available: null });
    await user.click(screen.getByRole("button", { name: "Check now" }));
    expect(remote.controller.checkUpgrade).toHaveBeenCalled();
  });

  it("disables Check now while checks are off", () => {
    const base = fakeView();
    renderSection({ available: null }, { settings: { ...base.settings!, autoUpgrade: "off" } });
    expect(screen.getByRole("button", { name: "Check now" })).toBeDisabled();
  });

  it("changes the automatic upgrade mode", async () => {
    const { remote, user } = renderSection();
    await user.click(screen.getByRole("radio", { name: "When idle" }));
    expect(remote.controller.updateSettings).toHaveBeenCalledWith({ autoUpgrade: "auto" });
  });

  it("points an older host to the command line", () => {
    renderSection({}, { upgrade: null, host: { protocol: { major: 5, minor: 29 } } });
    expect(screen.getByText("This host is too old to upgrade from here")).toBeInTheDocument();
  });
});
