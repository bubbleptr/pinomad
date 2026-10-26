// jsdom: the Hosts panel's two connection-routing rules. A mode change must
// reconnect the host this coordinator actually serves, and a token connection
// must not be torn down because a saved host's preference changed.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { RtcDiagnostics } from "@pinomad/protocol/remote-durable.ts";
import { HOME_HOST, fakeHosts } from "../../test/story-fixtures.tsx";
import { HostsContext, type HostsState } from "../../entities/host/host-store.ts";
import { HostsSection } from "./hosts.tsx";

const diagnostics: RtcDiagnostics = { path: "relay", phase: "active", cooldownRemainingMs: 0 };

function harness({
  connection,
  connectedHostKey,
  connectionMode,
}: {
  connection: "connected" | "closed" | "reconnecting" | undefined;
  connectedHostKey: string | undefined;
  connectionMode?: "auto" | "directOnly" | "relayOnly";
}) {
  const setConnection = vi.fn(async () => {});
  const state: HostsState = {
    ...fakeHosts([{ ...HOME_HOST, ...(connectionMode === undefined ? {} : { connectionMode }) }], HOME_HOST.hostKey),
    setConnection,
  };
  const remote = { rtcDiagnostics: () => diagnostics, setConnectionMode: vi.fn() };
  const onRetry = vi.fn();
  render(
    <HostsContext.Provider value={state}>
      <HostsSection
        connection={connection}
        connectedHostKey={connectedHostKey}
        remote={remote}
        hostMinor={23}
        rtcAvailable
        onRetry={onRetry}
      />
    </HostsContext.Provider>,
  );
  return { setConnection, remote, onRetry };
}

async function choose(mode: "Auto" | "Direct only" | "Relay only"): Promise<void> {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /^Connection to / }));
  await user.click(screen.getByRole("radio", { name: mode }));
}

describe("HostsSection connection mode", () => {
  it("switches the connected host's mode and reconnects it", async () => {
    const { setConnection, remote } = harness({
      connection: "connected",
      connectedHostKey: HOME_HOST.hostKey,
    });
    await choose("Relay only");
    await waitFor(() => expect(setConnection).toHaveBeenCalledWith(HOME_HOST.hostKey, { connectionMode: "relayOnly" }));
    await waitFor(() => expect(remote.setConnectionMode).toHaveBeenCalledWith("relayOnly"));
  });

  it("remounts a closed coordinator instead of asking it to switch modes", async () => {
    const { setConnection, remote, onRetry } = harness({
      connection: "closed",
      connectedHostKey: HOME_HOST.hostKey,
      connectionMode: "directOnly",
    });
    await choose("Auto");
    await waitFor(() => expect(setConnection).toHaveBeenCalledWith(HOME_HOST.hostKey, { connectionMode: "auto" }));
    await waitFor(() => expect(onRetry).toHaveBeenCalledTimes(1));
    expect(remote.setConnectionMode).not.toHaveBeenCalled();
  });

  it("stores a saved host's mode without reconnecting a token connection", async () => {
    const { setConnection, remote, onRetry } = harness({
      connection: "connected",
      connectedHostKey: undefined,
    });
    await choose("Direct only");
    await waitFor(() =>
      expect(setConnection).toHaveBeenCalledWith(HOME_HOST.hostKey, { connectionMode: "directOnly" }),
    );
    expect(remote.setConnectionMode).not.toHaveBeenCalled();
    expect(onRetry).not.toHaveBeenCalled();
  });
});
