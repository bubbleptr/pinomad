// `pinomad upgrade` following the host's own upgrade (ADR-0043 §8) over a
// real client connection; npm is faked and "restart" closes the faux host.
import { describe, expect, it } from "vitest";
import type { OpenedHost } from "../src/host.ts";
import { followUpgrade, hostUpgrade } from "../src/cli/upgrade-via-host.ts";
import type { Release } from "../src/upgrade/upgrader.ts";
import type { InstallResult } from "../src/upgrade/upgrader.ts";
import { connectTo, startFauxHost, useCleanups } from "./support.ts";

const defer = useCleanups();

async function host(options: { release?: Release; install?: () => Promise<InstallResult> } = {}) {
  let opened: OpenedHost | undefined;
  opened = await startFauxHost(defer, {
    answers: ["hello"],
    upgrade: {
      current: "0.13.0",
      restart: () => void opened?.close(),
      blocked: async () => null,
      latest: async () => options.release ?? { version: "0.14.0", publishedAt: Date.UTC(2026, 9, 1), protocolMajor: 5 },
      install: options.install ?? (async () => ({ ok: true })),
      every: () => () => {},
    },
  });
  const remote = await connectTo(defer, opened);
  return { remote, value: await hostUpgrade(remote) };
}

describe("followUpgrade", () => {
  it("follows the install until the host goes away to restart", async () => {
    const { remote, value } = await host();
    expect(value?.blocked).toBeNull();
    const lines: string[] = [];
    expect(await followUpgrade(remote, "idle", (line) => lines.push(line))).toEqual({ kind: "restarting", version: "0.14.0" });
    expect(lines).toEqual(["upgrading the host to pinomad@0.14.0", "installing pinomad@0.14.0"]);
  });

  it("reports a failed install, the host still up", async () => {
    const { remote } = await host({ install: async () => ({ ok: false, message: "npm ERR! E404" }) });
    expect(await followUpgrade(remote, "now", () => {})).toEqual({ kind: "failed", message: "npm ERR! E404" });
    expect(remote.view.current().connection).toBe("connected");
  });

  it("says so when the host already runs the latest release", async () => {
    const { remote } = await host({ release: { version: "0.13.0", publishedAt: 0, protocolMajor: 5 } });
    expect(await followUpgrade(remote, "idle", () => {})).toEqual({ kind: "current", version: "0.13.0" });
  });
});
