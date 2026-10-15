#!/usr/bin/env node
// `pinomad leave` / `bun run leave` — unbind this host from its server account
// (ADR-0022 §3). Local state is removed even when the server can't be reached:
// server.json goes away either way, and a warning says the server-side record
// may remain. The service definition loses --relay and restarts when idle.
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { relayHostId } from "@pinomad/protocol/relay.ts";
import { loadHostKey, loadRelayKey } from "../devices.ts";
import { commandHint } from "../distribution.ts";
import { readServerConfig, removeServerConfig } from "../server-config.ts";
import { withoutRelayArgs } from "../service/definition.ts";
import { serviceManager, type ServiceManager } from "../service/manager.ts";
import { probeServerAccounts, runServerOperation } from "./server-ops.ts";
import { restartService } from "./service.ts";
import { DEFAULT_DATA_DIR } from "./host-address.ts";

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export interface LeaveDeps {
  readonly manager?: ServiceManager;
  readonly fetch?: typeof fetch;
}

export interface LeaveOutcome {
  readonly origin: string;
  readonly hostId?: string;
  /** Warnings mean the leave may be incomplete (a server record or a live link may remain). */
  readonly warnings: readonly string[];
  /** Informational, not a failure — e.g. nothing to unbind or no service to restart. */
  readonly notes: readonly string[];
}

export async function leaveServer(
  args: { readonly dataDir: string },
  deps?: LeaveDeps,
): Promise<LeaveOutcome> {
  const dataDir = resolve(args.dataDir);
  const config = await readServerConfig(dataDir);
  if (config === undefined) throw new Error(`not joined — no server.json in ${dataDir}`);
  const origin = config.origin;
  const warnings: string[] = [];
  const notes: string[] = [];
  let hostId: string | undefined;

  if (await stat(join(dataDir, "relay-key")).then(() => true, () => false)) {
    const signingKey = await loadRelayKey(dataDir);
    const hostKey = await loadHostKey(dataDir);
    hostId = relayHostId(signingKey.publicKey);
    const probe = await probeServerAccounts(origin, deps?.fetch);
    if (probe === "unreachable") {
      warnings.push(`cannot reach ${origin} — the server-side binding was not removed`);
    } else if (probe === "enabled") {
      try {
        const reply = await runServerOperation({
          origin,
          signingKey,
          noisePublicKey: hostKey.publicKey,
          op: "leave",
        });
        if (reply.t === "refused" && reply.reason !== "not_joined") {
          warnings.push(`the server refused the leave: ${reply.reason}`);
        } else if (reply.t === "refused") {
          notes.push("the server had no binding for this host");
        }
      } catch (error) {
        warnings.push(`the server could not be asked to unbind (${message(error)}) — its record of this host may remain`);
      }
    } else {
      // "disabled": a server without accounts can't hold a binding at all.
      notes.push("the server runs no accounts — nothing was bound");
    }
  } else {
    // No relay-key: there is no way to prove the hostId to the server.
    warnings.push("no relay key on disk — the server-side binding, if any, was not removed");
  }

  // Local state goes regardless: the spec says an unreachable server must not
  // pin the local config.
  await removeServerConfig(dataDir);

  const manager = deps?.manager ?? serviceManager();
  const installed = await manager.state().then((state) => state.installed, () => false);
  if (!installed) {
    notes.push("no service installed — restart any running host so it stops dialing the server");
  } else {
    try {
      const previous = await manager.read();
      const stripped = previous === undefined ? undefined : { ...previous, hostArgs: withoutRelayArgs(previous.hostArgs) };
      const rewriting = stripped !== undefined && stripped.hostArgs.length !== previous!.hostArgs.length;
      const code = await restartService({
        force: false,
        argv: ["--data-dir", dataDir],
        manager,
        ...(rewriting
          ? {
              restart: async () => {
                await manager.install(stripped!);
              },
            }
          : {}),
      });
      if (code !== 0) warnings.push("the service restart did not finish — check `service status`");
    } catch (error) {
      warnings.push(`could not update the service definition: ${message(error)} — remove --relay from it and restart manually`);
    }
  }
  return {
    origin,
    ...(hostId === undefined ? {} : { hostId }),
    warnings,
    notes,
  };
}

export async function main(argv: readonly string[]): Promise<void> {
  const { values } = parseArgs({
    args: [...argv],
    options: { "data-dir": { type: "string" } },
  });
  try {
    const outcome = await leaveServer({ dataDir: values["data-dir"] ?? DEFAULT_DATA_DIR });
    console.log(`left ${outcome.origin}`);
    if (outcome.hostId !== undefined) console.log(`host id: ${outcome.hostId}`);
    for (const note of outcome.notes) console.log(`note: ${note}`);
    for (const warning of outcome.warnings) console.error(`warning: ${warning}`);
    if (outcome.warnings.length > 0) process.exitCode = 1;
  } catch (error) {
    console.error(message(error));
    process.exitCode = 1;
  }
}

if (import.meta.main) await main(process.argv.slice(2));
