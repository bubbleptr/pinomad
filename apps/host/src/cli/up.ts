#!/usr/bin/env node
// `pinomad up` / `bun run up` — set this host up in one command (#498). It
// asks how other devices should reach the host: through a PiNomad server
// (join.ts: a code confirmed in the browser), only on the LAN and tailnet
// (--remote-port, ADR-0008), or both; then writes the service (ADR-0009) once.
// `join`, `service install` and `host` stay for scripts and finer control.
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { commandHint } from "../distribution.ts";
import { normalizeOrigin, readRemovalNotice, readServerConfig } from "../server-config.ts";
import { argValue, isLauncher, LAUNCHER_EXECUTABLE, withoutArg, withoutRelayArgs } from "../service/definition.ts";
import { serviceManager } from "../service/manager.ts";
import { DEFAULT_DATA_DIR } from "./host-address.ts";
import { joinServer, type JoinDeps } from "./join.ts";
import { openServiceSlot, writeService, type ServiceWrite } from "./service-slot.ts";

/** Same as the apps' sign-in default (apps/web/src/shared/official-server.ts). */
export const OFFICIAL_SERVER_ORIGIN = "https://app.pinomad.si";
/** The LAN port the docs use. */
export const DEFAULT_REMOTE_PORT = "7422";

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The two ways other devices can reach a host; both may be on. */
export interface Reach {
  readonly server: boolean;
  readonly lan: boolean;
}

/**
 * What the flags decide, or undefined when they decide nothing and `up` has
 * to ask. On a host that is already set up, a flag changes only its own path;
 * on a fresh one, a single flag means that path alone (`--lan` is LAN only,
 * `--no-lan` is the server only).
 */
export function resolveReach(
  flags: { readonly server?: boolean | undefined; readonly lan?: boolean | undefined },
  current: Reach | undefined,
): Reach | undefined {
  if (flags.server === undefined && flags.lan === undefined) return undefined;
  if (current !== undefined) return { server: flags.server ?? current.server, lan: flags.lan ?? current.lan };
  return { server: flags.server ?? !flags.lan, lan: flags.lan ?? !flags.server };
}

/** The server that last removed this host (#512); an unreadable notice names none. */
const lastRemovedOrigin = async (dataDir: string): Promise<string | undefined> =>
  (await readRemovalNotice(dataDir).catch(() => undefined))?.origin;

/** How the host is reached today, or undefined on a host with neither a service nor a join. */
async function currentReach(dataDir: string, deps?: JoinDeps): Promise<Reach | undefined> {
  const slot = await openServiceSlot(dataDir, deps?.manager ?? serviceManager());
  const config = await readServerConfig(dataDir);
  if (config === undefined && !slot.state.installed) return undefined;
  return {
    server: config !== undefined,
    lan: argValue(slot.previous?.hostArgs ?? [], "--remote-port") !== undefined,
  };
}

/** Sets the LAN listener in host args: `--remote-port <port>`, or none at all (and no `--public-url`). */
function withLan(hostArgs: readonly string[], port: string | undefined): readonly string[] {
  if (port === undefined) return withoutArg(withoutArg(hostArgs, "--remote-port"), "--public-url");
  if (argValue(hostArgs, "--remote-port") === port) return hostArgs;
  return [...withoutArg(hostArgs, "--remote-port"), "--remote-port", port];
}

export interface UpOutcome {
  readonly joined?: {
    readonly origin: string;
    /** Missing for a server.json written before join recorded it. */
    readonly username?: string;
    /** False when the host was already joined to this server and nobody had to confirm. */
    readonly fresh: boolean;
  };
  /** The LAN port, when the LAN path is on. */
  readonly lanPort?: string;
  readonly service: ServiceWrite;
  readonly notes: readonly string[];
}

export async function upHost(
  args: {
    readonly dataDir: string;
    readonly reach: Reach;
    readonly origin?: string;
    readonly remotePort?: string;
    /** Join by a printed code instead of the browser redirect (#513). */
    readonly code?: boolean;
    /** A one-time join token: nobody confirms anything. Unspent when the host is already joined. */
    readonly token?: string;
    /** The Mac App's launcher for the service to run through (ServiceSpec.launcher). */
    readonly launcher?: string;
  },
  deps?: JoinDeps,
): Promise<UpOutcome> {
  const dataDir = resolve(args.dataDir);
  const { reach } = args;
  if (!reach.server && !reach.lan) throw new Error("nothing to set up: choose the server, the LAN, or both");
  // Checked before anything is written: the host would only fail at listen().
  const port = args.remotePort;
  if (port !== undefined && !(/^\d+$/.test(port) && Number(port) >= 1 && Number(port) <= 65535)) {
    throw new Error(`--remote-port must be a port number from 1 to 65535, got ${port}`);
  }
  const manager = deps?.manager ?? serviceManager();
  const slot = await openServiceSlot(dataDir, manager);
  const config = await readServerConfig(dataDir);
  // Without --origin a joined host stays with its own server, and one the
  // account removed goes back to the server that removed it (#512).
  const origin = normalizeOrigin(args.origin ?? config?.origin ?? (await lastRemovedOrigin(dataDir)) ?? OFFICIAL_SERVER_ORIGIN);
  if (reach.server && config !== undefined && normalizeOrigin(config.origin) !== origin) {
    throw new Error(
      `this host is joined to ${config.origin} — run \`${commandHint("leave")}\` first to join ${origin}, ` +
        `or leave out --origin to stay`,
    );
  }
  const lanPort = reach.lan
    ? (args.remotePort ?? argValue(slot.previous?.hostArgs ?? [], "--remote-port") ?? DEFAULT_REMOTE_PORT)
    : undefined;
  const lan = (hostArgs: readonly string[]) => withLan(hostArgs, lanPort);
  const notes: string[] = [];

  if (reach.server && config === undefined) {
    const joined = await joinServer(
      {
        origin,
        dataDir,
        code: args.code,
        ...(args.token === undefined ? {} : { token: args.token }),
        ...(args.launcher === undefined ? {} : { launcher: args.launcher }),
        editHostArgs: lan,
      },
      { ...deps, manager },
    );
    return {
      joined: { origin: joined.origin, username: joined.username, fresh: true },
      ...(lanPort === undefined ? {} : { lanPort }),
      service: joined.service,
      notes,
    };
  }
  // A legacy --relay goes only where server.json takes over from it.
  const edit = reach.server ? (hostArgs: readonly string[]) => lan(withoutRelayArgs(hostArgs)) : lan;
  // The server path always restarts: a join whose idle restart was cancelled
  // left server.json written but unread, and same args can't tell.
  const service = await writeService(slot, edit, { changed: reach.server, launcher: args.launcher });
  if (!reach.server && config !== undefined) {
    notes.push(`still joined to ${config.origin} — run \`${commandHint("leave")}\` to leave it`);
  }
  return {
    ...(reach.server && config !== undefined
      ? { joined: { origin: config.origin, ...(config.username === undefined ? {} : { username: config.username }), fresh: false } }
      : {}),
    ...(lanPort === undefined ? {} : { lanPort }),
    service,
    notes,
  };
}

export interface UpDeps extends JoinDeps {
  /** Whether there is a terminal to ask on; defaults to stdin and stdout both being TTYs. */
  readonly interactive?: boolean;
  /** Asks one question and resolves with the answer line. */
  readonly ask?: (question: string) => Promise<string>;
  /** All of stdin, for `--token-stdin`. */
  readonly readStdin?: () => Promise<string>;
}

async function readAllStdin(): Promise<string> {
  let text = "";
  for await (const chunk of process.stdin) text += String(chunk);
  return text;
}

async function askOnTerminal(question: string): Promise<string> {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await terminal.question(question);
  } finally {
    terminal.close();
  }
}

const CHOICES: readonly Reach[] = [
  { server: true, lan: false },
  { server: false, lan: true },
  { server: true, lan: true },
];

/** The menu, with today's setup (or the server) as the default answer. */
async function askReach(origin: string, fallback: Reach, ask: (question: string) => Promise<string>): Promise<Reach> {
  const preset = CHOICES.findIndex((choice) => choice.server === fallback.server && choice.lan === fallback.lan) + 1;
  let question =
    "How should your other devices reach this host?\n" +
    `  1) Through ${origin}: from anywhere, with push notifications\n` +
    "  2) Only on your local network and tailnet\n" +
    "  3) Both\n" +
    `Choose 1, 2 or 3 [${preset}]: `;
  for (;;) {
    const answer = (await ask(question)).trim();
    if (answer === "") return CHOICES[preset - 1]!;
    const picked = CHOICES[Number(answer) - 1];
    if (/^[123]$/.test(answer) && picked !== undefined) return picked;
    question = "Choose 1, 2 or 3: ";
  }
}

const FLAGS = `choose with flags:
  --server [--origin URL]   through a PiNomad server (default ${OFFICIAL_SERVER_ORIGIN})
  --lan [--remote-port N]   only on the local network and tailnet (default port ${DEFAULT_REMOTE_PORT})
  --server --lan            both
  --yes                     keep what this host has, or the server on a new host
  --token-stdin             join with a one-time token read from stdin, without a code`;

export async function main(argv: readonly string[], deps?: UpDeps): Promise<void> {
  const { values } = parseArgs({
    args: [...argv],
    allowNegative: true,
    options: {
      server: { type: "boolean" },
      lan: { type: "boolean" },
      yes: { type: "boolean", short: "y" },
      origin: { type: "string" },
      code: { type: "boolean" },
      // stdin, not argv: other processes can read argv (the Mac App passes it so).
      "token-stdin": { type: "boolean" },
      // The Mac App's launcher (ServiceSpec.launcher); only the app passes it.
      launcher: { type: "string" },
      "remote-port": { type: "string" },
      "data-dir": { type: "string" },
    },
  });
  const log = deps?.log ?? ((line: string) => console.log(line));
  try {
    const dataDir = resolve(values["data-dir"] ?? DEFAULT_DATA_DIR);
    const launcher = values.launcher;
    if (launcher !== undefined && process.platform !== "darwin") throw new Error("--launcher is for the Mac App's service only");
    if (launcher !== undefined && !(isAbsolute(launcher) && isLauncher(launcher))) {
      throw new Error(`--launcher ${launcher}: not a path to the launcher inside an app (….app/Contents/MacOS/${LAUNCHER_EXECUTABLE})`);
    }
    // A plist naming a missing file would keep the host from starting at all.
    if (launcher !== undefined && !existsSync(launcher)) throw new Error(`--launcher ${launcher}: no such file`);
    let token: string | undefined;
    if (values["token-stdin"] === true) {
      token = (await (deps?.readStdin ?? readAllStdin)()).trim();
      if (token === "") throw new Error("--token-stdin: no join token on stdin");
    }
    const origin = normalizeOrigin(
      values.origin ?? (await readServerConfig(dataDir))?.origin ?? (await lastRemovedOrigin(dataDir)) ?? OFFICIAL_SERVER_ORIGIN,
    );
    // Also refuses another data dir's service before anyone is asked anything.
    const current = await currentReach(dataDir, deps);
    let reach = resolveReach({ server: values.server, lan: values.lan }, current);
    if (reach === undefined) {
      // A local-only service has no path on to keep; the server is the default then.
      const fallback = current !== undefined && (current.server || current.lan) ? current : { server: true, lan: false };
      if (values.yes === true) {
        reach = fallback;
      } else if (!(deps?.interactive ?? (process.stdin.isTTY && process.stdout.isTTY))) {
        console.error(`${commandHint("up")}: no terminal to ask how other devices reach this host — ${FLAGS}`);
        process.exitCode = 2;
        return;
      } else {
        reach = await askReach(origin, fallback, deps?.ask ?? askOnTerminal);
      }
    }
    if (!reach.server && !reach.lan) {
      console.error(
        `${commandHint("up")}: neither the server nor the LAN would be on — ` +
          `\`${commandHint("service")} install\` runs a host only this machine can reach`,
      );
      process.exitCode = 2;
      return;
    }

    const outcome = await upHost(
      {
        dataDir,
        origin,
        reach,
        ...(values["remote-port"] === undefined ? {} : { remotePort: values["remote-port"] }),
        ...(values.code === true ? { code: true } : {}),
        ...(token === undefined ? {} : { token }),
        ...(launcher === undefined ? {} : { launcher }),
      },
      deps,
    );
    if (outcome.joined !== undefined) {
      const who = outcome.joined.username ?? "an account";
      log(outcome.joined.fresh ? `joined ${who} at ${outcome.joined.origin}` : `already joined ${who} at ${outcome.joined.origin}`);
      log(`Sign in at ${outcome.joined.origin} on your other devices; they pair with this host on their own.`);
    }
    if (outcome.lanPort !== undefined) {
      log(`LAN and tailnet: port ${outcome.lanPort}. Pair a device with \`${commandHint("pair")}\`.`);
    }
    for (const note of outcome.notes) log(`note: ${note}`);
    if (outcome.service === "installed") log("service installed and started");
    else if (outcome.service === "updated") log("service updated; host restarted when idle");
    else if (outcome.service === "unchanged") log("service already running with these settings");
    else {
      console.error(`the service restart did not finish — check \`${commandHint("status")}\``);
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(message(error));
    process.exitCode = 1;
  }
}

if (import.meta.main) await main(process.argv.slice(2));
