#!/usr/bin/env node
// `pinomad join <origin> <token>` / `bun run join` — bind this host to a
// server account (ADR-0022 §3). Order matters: both keys exist before the
// server is asked, the binding lands before server.json is written, and the
// service definition is rewritten (dropping a legacy --relay) and restarted
// when idle (ADR-0009 §5). With no service installed, join installs one —
// the one-command bring-up this command exists for.
import { mkdir } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { relayHostId } from "@pinomad/protocol/relay.ts";
import { cleanHostName, normalizeHostName } from "@pinomad/protocol/settings.ts";
import type { ModelSummary } from "@pinomad/protocol/view.ts";
import { loadHostKey, loadRelayKey } from "../devices.ts";
import { commandHint, hostEntry } from "../distribution.ts";
import { openHostSettings } from "../host-settings.ts";
import { constantValue } from "../host-value.ts";
import { writeServerConfig } from "../server-config.ts";
import { argValue, installSpec, withoutRelayArgs, type ServiceSpec } from "../service/definition.ts";
import { serviceManager, type ServiceManager } from "../service/manager.ts";
import { assertSecureServerOrigin, probeServerAccounts, runServerOperation } from "./server-ops.ts";
import { restartService } from "./service.ts";
import { DEFAULT_DATA_DIR } from "./host-address.ts";

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export interface JoinDeps {
  /** Tests inject a fake; production resolves the platform manager lazily. */
  readonly manager?: ServiceManager;
  readonly fetch?: typeof fetch;
  readonly hostname?: string;
}

export interface JoinOutcome {
  readonly hostId: string;
  readonly username: string;
  readonly origin: string;
  /** "installed" when no service existed, "updated" after a rewrite + idle restart. */
  readonly service: "installed" | "updated" | "failed";
}

export async function joinServer(
  args: { readonly origin: string; readonly token: string; readonly dataDir: string; readonly name?: string },
  deps?: JoinDeps,
): Promise<JoinOutcome> {
  const origin = args.origin.replace(/\/+$/, "");
  const dataDir = resolve(args.dataDir);
  // TLS-only before anything else: the token must never ride plaintext ws.
  assertSecureServerOrigin(origin);
  // --name becomes the settings.json hostName (issue #212): a name that
  // cleans to nothing has nothing to show — fail before spending the token.
  if (args.name !== undefined && cleanHostName(args.name) === "") {
    throw new Error(`Invalid host name: ${JSON.stringify(args.name)}`);
  }
  await mkdir(dataDir, { recursive: true });
  // Both identities exist before the server is asked: the join signature binds
  // the Noise key, and a fresh install needs them either way.
  const signingKey = await loadRelayKey(dataDir);
  const hostKey = await loadHostKey(dataDir);
  const hostId = relayHostId(signingKey.publicKey);

  // Check the service slot before spending the token: there's exactly one
  // unit, and rewriting a definition whose data dir is another host's would
  // take that host offline and leave this join unserved.
  const manager = deps?.manager ?? serviceManager();
  const installed = await manager.state().then((state) => state.installed, () => false);
  const previous = installed ? await manager.read() : undefined;
  if (previous !== undefined && resolve(previous.dataDir) !== dataDir) {
    throw new Error(
      `the installed service uses a different data dir (${previous.dataDir}); ` +
        `join it with --data-dir ${previous.dataDir} or uninstall the service first`,
    );
  }

  const probe = await probeServerAccounts(origin, deps?.fetch);
  if (probe === "unreachable") throw new Error(`cannot reach ${origin} — check the address and that the server is up`);
  if (probe === "disabled") {
    throw new Error(`${origin} does not run server accounts — the server is too old or was started without a data dir`);
  }

  // Opened before the operation so the reported name is the effective one —
  // --name, else the settings.json override, else the machine name — and a
  // malformed file fails before the token is spent.
  const settings = await openHostSettings({
    path: join(dataDir, "settings.json"),
    fallback: {
      defaultModel: () => null,
      defaultThinkingLevel: () => null,
      steeringMode: () => "one-at-a-time",
      followUpMode: () => "one-at-a-time",
    },
    models: constantValue<readonly ModelSummary[]>([]),
  });
  const current = settings.value;
  const storedName = current.custom.includes("hostName") ? current.hostName : undefined;
  const reply = await runServerOperation({
    origin,
    signingKey,
    noisePublicKey: hostKey.publicKey,
    op: "join",
    joinToken: args.token,
    name: normalizeHostName(args.name ?? storedName ?? deps?.hostname ?? hostname()),
  });
  if (reply.t === "refused") {
    throw new Error(
      reply.reason === "expired_token"
        ? "the join token expired — generate a fresh one"
        : reply.reason === "invalid_token"
          ? "the join token is invalid or already spent — generate a fresh one"
          : `the server refused the join: ${reply.reason}`,
    );
  }
  if (reply.t !== "joined") throw new Error(`unexpected answer to join: ${reply.t}`);
  const username = reply.username;

  // The binding exists from here on. A local failure below leaves the server
  // side done; re-running join with a fresh token is an idempotent upsert.
  let service: JoinOutcome["service"];
  try {
    await writeServerConfig(dataDir, { origin });
    // --name is a settings override now (issue #212): persist it after the
    // binding landed, before the restart below makes it effective. A host
    // running in the foreground keeps its old name until restarted.
    if (args.name !== undefined) await settings.update({ hostName: args.name });
    const freshSpec = installSpec(["--data-dir", dataDir], {
      execPath: process.execPath,
      env: process.env,
      home: homedir(),
      cwd: process.cwd(),
      mainPath: hostEntry.script,
      entryArgs: hostEntry.args,
    });
    if (!installed) {
      await manager.install(freshSpec);
      service = "installed";
    } else {
      // server.json now carries the origin — drop a pinned --relay so a later
      // re-join elsewhere can't contradict the definition.
      const spec: ServiceSpec =
        previous === undefined ? freshSpec : { ...previous, hostArgs: withoutRelayArgs(previous.hostArgs) };
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
      service = code === 0 ? "updated" : "failed";
    }
  } catch (error) {
    throw new Error(
      `joined ${username} at ${origin}, but local setup failed: ${message(error)}\n` +
        `generate a fresh join token and run the command again (re-joining the same host is safe)`,
    );
  }
  return { hostId, username, origin, service };
}

export async function main(argv: readonly string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: { "data-dir": { type: "string" }, name: { type: "string" } },
  });
  const [origin, token] = positionals;
  if (origin === undefined || token === undefined) {
    console.error(`usage: ${commandHint("join")} <server-origin> <join-token> [--data-dir DIR] [--name NAME]`);
    process.exit(1);
  }
  try {
    const outcome = await joinServer({
      origin,
      token,
      dataDir: values["data-dir"] ?? DEFAULT_DATA_DIR,
      ...(values.name === undefined ? {} : { name: values.name }),
    });
    console.log(`host id: ${outcome.hostId}`);
    console.log(`joined ${outcome.username} at ${outcome.origin}`);
    if (outcome.service === "installed") console.log("service installed and started");
    else if (outcome.service === "updated") console.log("service definition updated; host restarted when idle");
    else {
      console.error("joined, but the service restart did not finish — check `service status`");
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(message(error));
    process.exitCode = 1;
  }
}

if (import.meta.main) await main(process.argv.slice(2));
