// `pinomad service start|stop` (#501): the Mac App's local-host switch runs
// these against the installed host. Stop waits for running tasks like a
// restart does, knocking on the port the installed service listens on.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import { serviceStatusJson, startService, stopService } from "../src/cli/service.ts";
import { launchdDisabled, launchdState } from "../src/service/manager.ts";
import type { ServiceManager, ServiceState } from "../src/service/manager.ts";
import { seededSpec } from "./server-support.ts";
import { tempDir, useCleanups } from "./support.ts";

const defer = useCleanups();

const RUNNING: ServiceState = { installed: true, stopped: false, running: true, pid: 42, detail: "running, pid 42" };
const STOPPED: ServiceState = { installed: true, stopped: true, running: false, detail: "stopped" };
const MISSING: ServiceState = { installed: false, stopped: false, running: false, detail: "not installed" };

function manager(state: ServiceState, dataDir = "/nowhere", hostArgs: readonly string[] = []) {
  const calls: string[] = [];
  const fake: ServiceManager = {
    install: async () => "/fake/pinomad.host.plist",
    uninstall: async () => {},
    restart: async () => {},
    start: async () => {
      calls.push("start");
    },
    stop: async () => {
      calls.push("stop");
    },
    state: async () => state,
    logs: async () => {},
    read: async () => (state.installed ? seededSpec(dataDir, hostArgs) : undefined),
  };
  return { manager: fake, calls };
}

/** A connected host with one live task until `finish()`. */
function busyHost() {
  let tasks: Record<string, unknown> = { t1: { kind: "turn", conversationId: "c1" } };
  const listeners = new Set<() => void>();
  const remote = {
    view: {
      current: () => ({ connection: "connected", tasks: { tasks } }),
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    controller: { toggleTasks: async () => {} },
    close: () => {},
  } as unknown as RemoteDurable;
  return {
    remote,
    finish: () => {
      tasks = {};
      for (const listener of listeners) listener();
    },
  };
}

describe("stopService", () => {
  it("waits for running tasks on the installed host's own port and data dir, then stops it", async () => {
    const data = await tempDir();
    defer(data.remove);
    await writeFile(join(data.path, "token"), "tok\n");
    const { manager: fake, calls } = manager(RUNNING, data.path, ["--port", "7555"]);
    const host = busyHost();
    let busy!: () => void;
    const announced = new Promise<void>((resolve) => (busy = resolve));
    const lines: string[] = [];
    const connect = vi.fn(async () => host.remote);

    const stopping = stopService({
      force: false,
      argv: [],
      manager: fake,
      connect,
      log: (line) => {
        lines.push(line);
        if (line.startsWith("waiting")) busy();
      },
    });
    await announced;
    expect(calls).toEqual([]);
    host.finish();

    expect(await stopping).toBe(0);
    expect(calls).toEqual(["stop"]);
    expect(connect).toHaveBeenCalledWith("ws://127.0.0.1:7555", "tok");
    expect(lines.join("\n")).toContain("conversation c1");
  });

  it("stops at once with --force, and when the host doesn't answer", async () => {
    const forced = manager(RUNNING);
    const connect = vi.fn(async () => busyHost().remote);
    expect(await stopService({ force: true, argv: [], manager: forced.manager, connect, log: () => {} })).toBe(0);
    expect(connect).not.toHaveBeenCalled();
    expect(forced.calls).toEqual(["stop"]);

    const down = manager(RUNNING);
    const refused = async (): Promise<RemoteDurable> => Promise.reject(new Error("refused"));
    expect(await stopService({ force: false, argv: [], manager: down.manager, connect: refused, log: () => {} })).toBe(0);
    expect(down.calls).toEqual(["stop"]);
  });

  it("leaves a stopped service alone, and refuses when nothing is installed", async () => {
    const stopped = manager(STOPPED);
    expect(await stopService({ force: true, argv: [], manager: stopped.manager, log: () => {} })).toBe(0);
    expect(stopped.calls).toEqual([]);

    const missing = manager(MISSING);
    expect(await stopService({ force: true, argv: [], manager: missing.manager, log: () => {} })).toBe(1);
    expect(missing.calls).toEqual([]);
  });
});

describe("startService", () => {
  it("starts an installed service and refuses when there is none", async () => {
    const stopped = manager(STOPPED);
    expect(await startService({ manager: stopped.manager, log: () => {} })).toBe(0);
    expect(stopped.calls).toEqual(["start"]);

    const missing = manager(MISSING);
    expect(await startService({ manager: missing.manager, log: () => {} })).toBe(1);
    expect(missing.calls).toEqual([]);
  });
});

describe("service status --json", () => {
  it("is the shape the Mac App reads: one line, the service state only", () => {
    const line = serviceStatusJson(RUNNING);
    expect(line).not.toContain("\n");
    expect(JSON.parse(line)).toEqual({ installed: true, stopped: false, running: true, pid: 42, detail: "running, pid 42" });
    expect(JSON.parse(serviceStatusJson(MISSING))).toEqual({ installed: false, stopped: false, running: false, detail: "not installed" });
  });
});

describe("launchdDisabled", () => {
  it("reads the label's override from launchctl print-disabled, old and new formats", () => {
    const now = 'disabled services = {\n\t\t"pinomad.host" => disabled\n\t\t"com.other" => enabled\n\t}';
    const old = 'disabled services = {\n\t\t"pinomad.host" => true\n\t}';
    expect(launchdDisabled(now)).toBe(true);
    expect(launchdDisabled(old)).toBe(true);
    expect(launchdDisabled('\t\t"pinomad.host" => enabled')).toBe(false);
    expect(launchdDisabled('\t\t"pinomad.host" => false')).toBe(false);
    // Another label that ends the same way is not ours.
    expect(launchdDisabled('\t\t"x.pinomad.host" => disabled')).toBe(false);
    expect(launchdDisabled("disabled services = {\n\t}")).toBe(false);
  });
});

describe("launchdState", () => {
  const loaded = "pinomad.host = {\n\tstate = running\n\tpid = 42\n}";

  it("is stopped only once disabled and no longer loaded", () => {
    expect(launchdState(true, undefined)).toMatchObject({ installed: true, stopped: true, running: false });
  });

  it("a disabled host launchd still runs is not stopped, so stop can finish the job", () => {
    // disable went through, bootout failed or never ran.
    expect(launchdState(true, loaded)).toMatchObject({ installed: true, stopped: false, running: true, pid: 42 });
  });

  it("an enabled host reads from launchctl print", () => {
    expect(launchdState(false, loaded)).toMatchObject({ stopped: false, running: true, pid: 42 });
    expect(launchdState(false, undefined)).toMatchObject({ stopped: false, running: false, detail: "not loaded" });
  });
});
