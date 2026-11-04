// Add a host in the Mac app (#501): Set up this Mac only shows when no host
// is installed here, so it never offers a second install.
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { AccountContext } from "../../entities/account/account-context.tsx";
import type { DesktopBridge } from "../../entities/host/desktop-bridge.ts";
import type { LocalHostState } from "../../entities/local-host/local-host-protocol.ts";
import { fakeAccount, fakeLocalHost, signedIn } from "../../test/story-fixtures.tsx";
import { AddHostSteps } from "./add-host.tsx";

afterEach(() => {
  delete window.pinomadDesktop;
});

function renderSteps(state: LocalHostState) {
  const localHost = fakeLocalHost({ state });
  window.pinomadDesktop = { localHost } as unknown as DesktopBridge;
  render(
    <AccountContext.Provider value={fakeAccount(signedIn())}>
      <AddHostSteps serverOrigin="https://pinomad.si" />
    </AccountContext.Provider>,
  );
  return localHost;
}

describe("AddHostSteps on a Mac", () => {
  it("sets up this Mac for this server when no host is installed here", async () => {
    const localHost = renderSteps({ kind: "not-installed" });
    await userEvent.click(await screen.findByRole("button", { name: "Set up this Mac" }));
    await waitFor(() => expect(localHost.join).toHaveBeenCalledWith("https://pinomad.si", expect.any(String)));
    // Joined and running: the offer goes.
    await waitFor(() => expect(screen.queryByRole("button", { name: "Set up this Mac" })).not.toBeInTheDocument());
  });

  it("offers nothing extra once this Mac has a host", async () => {
    const localHost = renderSteps({ kind: "installed", running: true, stopped: false, stopping: false, detail: "running" });
    await waitFor(() => expect(localHost.state).toHaveResolved());
    await act(async () => {});
    expect(screen.queryByRole("button", { name: "Set up this Mac" })).not.toBeInTheDocument();
  });
});
