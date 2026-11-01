// The one host service a machine has (ADR-0009), as join and up see it:
// checked before anything is spent, rewritten once at the end. Only the host
// args change on a rewrite; node, script, PATH and data dir stay as installed.
import { homedir } from "node:os";
import { resolve } from "node:path";
import { hostEntry } from "../distribution.ts";
import { argValue, installSpec, type ServiceSpec } from "../service/definition.ts";
import type { ServiceManager, ServiceState } from "../service/manager.ts";
import { restartService } from "./service.ts";

export interface ServiceSlot {
  readonly dataDir: string;
  readonly manager: ServiceManager;
  readonly state: ServiceState;
  /** The installed definition; undefined when nothing is installed. */
  readonly previous: ServiceSpec | undefined;
}

export type ServiceWrite = "installed" | "updated" | "unchanged" | "failed";

/**
 * Reads the slot and refuses one owned by another data dir: rewriting it
 * would take that host offline and leave this one unserved.
 */
export async function openServiceSlot(dataDir: string, manager: ServiceManager): Promise<ServiceSlot> {
  const state = await manager.state().catch((): ServiceState => ({ installed: false, running: false, detail: "unknown" }));
  const previous = state.installed ? await manager.read() : undefined;
  if (previous !== undefined && resolve(previous.dataDir) !== dataDir) {
    throw new Error(
      `the installed service uses a different data dir (${previous.dataDir}); ` +
        `run this again with --data-dir ${previous.dataDir} or uninstall the service first`,
    );
  }
  return { dataDir, manager, state, previous };
}

/**
 * Installs the service with `edit([])` as its host args, or rewrites the
 * installed one with `edit(previous)` and restarts it when idle. With
 * `changed: false` (nothing else, such as server.json, moved underneath the
 * host), a running service whose args come out the same is left alone.
 */
export async function writeService(
  slot: ServiceSlot,
  edit: (hostArgs: readonly string[]) => readonly string[],
  options: { readonly changed: boolean },
): Promise<ServiceWrite> {
  const { dataDir, manager, previous } = slot;
  const fresh = installSpec(["--data-dir", dataDir, ...edit([])], {
    execPath: process.execPath,
    env: process.env,
    home: homedir(),
    cwd: process.cwd(),
    mainPath: hostEntry.script,
    entryArgs: hostEntry.args,
  });
  if (!slot.state.installed) {
    await manager.install(fresh);
    return "installed";
  }
  const spec = previous === undefined ? fresh : { ...previous, hostArgs: edit(previous.hostArgs) };
  const same = previous !== undefined && spec.hostArgs.join("\0") === previous.hostArgs.join("\0");
  if (same && !options.changed && slot.state.running) return "unchanged";
  // Idle-wait must knock on the port the service actually listens on —
  // the default 7420 would look dead and force a mid-task restart.
  const port = argValue(spec.hostArgs, "--port");
  const code = await restartService({
    force: false,
    argv: ["--data-dir", dataDir, ...(port === undefined ? [] : ["--url", `ws://127.0.0.1:${port}`])],
    manager,
    restart: async () => {
      await manager.install(spec);
    },
  });
  return code === 0 ? "updated" : "failed";
}
