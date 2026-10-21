// jsdom: the desktop-only update UI — the Settings indicator, the Updates section, and the
// client-older mismatch screen — driven by a stand-in preload bridge.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VersionMismatch } from "../../App.tsx";
import { SidebarFooter } from "../../widgets/app-frame/sidebar.tsx";
import { UpdatesSection } from "../../widgets/app-frame/updates-section.tsx";
import type { DesktopBridge } from "../host/desktop-bridge.ts";
import type { UpdateStatus } from "./update-protocol.ts";

function fakeUpdates(initial: UpdateStatus) {
  const listeners = new Set<(status: UpdateStatus) => void>();
  let status = initial;
  return {
    // Resolved lazily, like the real invoke: the renderer sees the latest
    // status, not whatever the updater happened to hold when the call went out.
    status: vi.fn(() => Promise.resolve().then(() => status)),
    check: vi.fn(async () => status),
    install: vi.fn(async () => status),
    onStatus: (listener: (status: UpdateStatus) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next: UpdateStatus) {
      status = next;
      for (const listener of [...listeners]) listener(next);
    },
  };
}

const installBridge = (updates: ReturnType<typeof fakeUpdates>) => {
  window.pinomadDesktop = {
    updates,
    hosts: { list: async () => [], save: async () => {}, remove: async () => {}, setName: async () => {} },
  } satisfies DesktopBridge;
};

const clientOlder = { direction: "client-older" as const, hostMajor: 6, clientMajor: 5 };
const RELOADED_KEY = "pinomad.reloadedForProtocol";

beforeEach(() => {
  delete window.pinomadDesktop;
  sessionStorage.clear();
});

describe("SidebarFooter update indicator", () => {
  const footer = (
    <SidebarFooter view={{ connection: "connected", settings: null } as never} onOpenSettings={() => {}} onOpenAccount={() => {}} />
  );

  it("marks Settings only once an update is downloaded", async () => {
    const updates = fakeUpdates({ state: "idle", currentVersion: "0.1.0" });
    installBridge(updates);
    render(footer);
    await waitFor(() => expect(updates.status).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: "Settings" })).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "Update ready" })).not.toBeInTheDocument();
    expect(screen.queryByText("Restart to update")).not.toBeInTheDocument();

    updates.set({ state: "ready", currentVersion: "0.1.0", availableVersion: "0.2.0" });
    expect(await screen.findByRole("img", { name: "Update ready" })).toBeInTheDocument();
  });

  it("shows no indicator in the browser", () => {
    render(footer);
    expect(screen.queryByRole("img", { name: "Update ready" })).not.toBeInTheDocument();
  });
});

describe("UpdatesSection", () => {
  it("restarts into the downloaded update", async () => {
    const updates = fakeUpdates({ state: "ready", currentVersion: "0.1.0", availableVersion: "0.2.0" });
    installBridge(updates);
    render(<UpdatesSection />);
    expect(await screen.findByText("PiNomad 0.1.0")).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Restart to update" }));
    expect(updates.install).toHaveBeenCalledTimes(1);
  });

  it("checks for updates on request", async () => {
    const updates = fakeUpdates({ state: "idle", currentVersion: "0.1.0" });
    installBridge(updates);
    render(<UpdatesSection />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Check for updates" }));
    expect(updates.check).toHaveBeenCalledTimes(1);
  });
});

describe("VersionMismatch on the desktop bridge", () => {
  // jsdom serves the page at http://localhost:3000 — a ws url on the same host
  // makes the browser's reload-once path reachable, which is exactly what the
  // desktop path must NOT take.
  const wsUrl = "ws://localhost:3000";

  it("checks for an update instead of reloading when the client is older", async () => {
    const updates = fakeUpdates({ state: "checking", currentVersion: "0.1.0" });
    installBridge(updates);
    render(<VersionMismatch wsUrl={wsUrl} mismatch={clientOlder} />);
    await waitFor(() => expect(updates.check).toHaveBeenCalledTimes(1));
    expect(sessionStorage.getItem(RELOADED_KEY)).toBeNull();
    expect(await screen.findByText("Checking for updates…")).toBeInTheDocument();
  });

  it("offers Restart to update once the download lands", async () => {
    const updates = fakeUpdates({ state: "checking", currentVersion: "0.1.0" });
    installBridge(updates);
    render(<VersionMismatch wsUrl={wsUrl} mismatch={clientOlder} />);
    updates.set({ state: "ready", currentVersion: "0.1.0", availableVersion: "0.2.0" });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Restart to update" }));
    expect(updates.install).toHaveBeenCalledTimes(1);
  });

  it("shows the error and retries the check", async () => {
    const updates = fakeUpdates({ state: "error", currentVersion: "0.1.0", message: "update feed unreachable" });
    installBridge(updates);
    render(<VersionMismatch wsUrl={wsUrl} mismatch={clientOlder} />);
    expect(await screen.findByText("update feed unreachable")).toBeInTheDocument();
    const before = updates.check.mock.calls.length;
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(updates.check).toHaveBeenCalledTimes(before + 1);
  });

  it("says updates are unavailable when the updater is disabled", async () => {
    installBridge(fakeUpdates({ state: "disabled", currentVersion: "0.1.0", reason: "Updates are unavailable in this build." }));
    render(<VersionMismatch wsUrl={wsUrl} mismatch={clientOlder} />);
    expect(await screen.findByText("Updates are unavailable in this build.")).toBeInTheDocument();
  });
});

describe("VersionMismatch in the browser", () => {
  it("still reloads once when the host itself served the page", () => {
    render(<VersionMismatch wsUrl="ws://localhost:3000" mismatch={clientOlder} />);
    // The reload itself is a jsdom no-op; the marker proves the path ran.
    expect(sessionStorage.getItem(RELOADED_KEY)).toBe(String(clientOlder.hostMajor));
  });

  it("shows the host-older banner when the page was not served by that host", () => {
    render(<VersionMismatch wsUrl="ws://elsewhere:9000" mismatch={{ direction: "host-older", hostMajor: 4, clientMajor: 5 }} />);
    expect(sessionStorage.getItem(RELOADED_KEY)).toBeNull();
    expect(screen.getByText(/pinomad upgrade/)).toBeInTheDocument();
  });
});
