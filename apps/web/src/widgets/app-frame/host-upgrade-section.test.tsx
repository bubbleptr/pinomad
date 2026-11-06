// Settings → Upgrade (ADR-0043): which actions a host's `upgrade` state offers
// and which calls they make. The fake remote's spies stand in for the host.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { HostUpgrade } from "@pinomad/protocol/upgrade.ts";
import { fakeRemote, fakeUpgrade, fakeView } from "../../test/story-fixtures.tsx";
import { HostUpgradeSection } from "./host-upgrade-section.tsx";

function renderSection(upgrade: Partial<HostUpgrade> = {}, overrides: Parameters<typeof fakeView>[0] = {}) {
  const view = fakeView({ upgrade: fakeUpgrade(upgrade), ...overrides });
  const remote = fakeRemote(view);
  render(<HostUpgradeSection view={view} remote={remote} />);
  return { remote, user: userEvent.setup() };
}

describe("HostUpgradeSection", () => {
  it("upgrades when idle after the confirmation", async () => {
    const { remote, user } = renderSection();
    await user.click(screen.getByRole("button", { name: "Upgrade…" }));
    await user.click(screen.getByRole("button", { name: "Upgrade when idle" }));
    expect(remote.controller.startUpgrade).toHaveBeenCalledWith("idle");
  });

  it("warns in the confirmation when the release crosses a protocol major", async () => {
    const { user } = renderSection({ available: { version: "1.0.0", publishedAt: Date.now(), crossesMajor: true } });
    await user.click(screen.getByRole("button", { name: "Upgrade…" }));
    const confirm = screen.getByRole("group", { name: "Upgrade the host to pinomad 1.0.0?" });
    expect(confirm).toHaveTextContent("Apps that haven't updated yet can't connect");
    expect(confirm).toHaveTextContent("Open terminals close");
  });

  it("cancels a wait", async () => {
    const { remote, user } = renderSection({ phase: "waiting", target: "0.14.0" });
    expect(screen.queryByRole("button", { name: "Upgrade…" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Cancel upgrade" }));
    expect(remote.controller.cancelUpgrade).toHaveBeenCalled();
  });

  it("offers no actions while installing", () => {
    renderSection({ phase: "installing", target: "0.14.0" });
    expect(screen.getByText(/Installing pinomad 0.14.0/)).toBeInTheDocument();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("shows the command instead of the button when the host can't upgrade itself", () => {
    renderSection({ blocked: "no-service" });
    expect(screen.queryByRole("button", { name: "Upgrade…" })).toBeNull();
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
