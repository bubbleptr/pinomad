// jsdom: the Hosts panel's per-host connection routing. A mode change must
// reach the coordinator that actually serves that host, and a host with no
// ready coordinator is only persisted.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { RtcDiagnostics } from "@pinomad/protocol/remote-durable.ts";
import type { DurableView } from "@pinomad/protocol/view.ts";
import { HOME_HOST, fakeHosts, fakeRemote, fakeView } from "../../test/story-fixtures.tsx";
import {
  createHostRuntimeRegistry,
  HostRuntimesContext,
  type HostRuntimeInfo,
} from "../../entities/host/host-runtimes.ts";
import { HostsContext, type HostsState } from "../../entities/host/host-store.ts";
import { HostsSection } from "./hosts.tsx";

const diagnostics: RtcDiagnostics = { path: "relay", phase: "active", cooldownRemainingMs: 0 };

function harness({
  connection,
  connectionMode,
  withRuntime = true,
}: {
  connection: DurableView["connection"];
  connectionMode?: "auto" | "directOnly" | "relayOnly";
  withRuntime?: boolean;
}) {
  const setConnection = vi.fn(async () => {});
  const state: HostsState = {
    ...fakeHosts([{ ...HOME_HOST, ...(connectionMode === undefined ? {} : { connectionMode }) }], HOME_HOST.hostKey),
    setConnection,
  };
  const retry = vi.fn();
  const view = fakeView({ connection, host: { version: "0.9.0", protocol: { major: 5, minor: 23, patch: 0 } } } as never);
  const remote = {
    ...fakeRemote(view),
    rtcDiagnostics: () => diagnostics,
    setConnectionMode: vi.fn(),
  };
  const registry = createHostRuntimeRegistry();
  if (withRuntime) {
    const info: HostRuntimeInfo = { phase: "ready", remote, view, retry };
    registry.publish(HOME_HOST.hostKey, info);
  }
  render(
    <HostsContext.Provider value={state}>
      <HostRuntimesContext.Provider value={registry}>
        <HostsSection rtcAvailable />
      </HostRuntimesContext.Provider>
    </HostsContext.Provider>,
  );
  return { setConnection, remote, retry };
}

async function choose(mode: "Auto" | "Direct only" | "Relay only"): Promise<void> {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /^Connection to / }));
  await user.click(screen.getByRole("radio", { name: mode }));
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
