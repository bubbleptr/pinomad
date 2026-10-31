#!/usr/bin/env node
// The published `pinomad` CLI (ADR-0016): one package holds the host, the
// server, and the built web client. Subcommands load lazily so `pinomad pair`
// doesn't pay for the pi stack; bundled, each lazy import is a sibling chunk.
import { packagedVersion } from "@pinomad/host/src/distribution.ts";
import { isParseArgsError, reportParseArgsError } from "@pinomad/host/src/cli/args.ts";

type CommandModule = { main(argv: readonly string[]): Promise<void> };

const COMMANDS: Record<string, () => Promise<CommandModule>> = {
  host: () => import("@pinomad/host/src/main.ts"),
  server: () => import("@pinomad/server/src/main.ts"),
  // The old name of `server`. Deployed images run `pinomad relay` (the
  // pinned 0.4.0 has no `server`), so it stays an alias.
  relay: () => import("@pinomad/server/src/main.ts"),
  service: () => import("@pinomad/host/src/cli/service.ts"),
  upgrade: () => import("@pinomad/host/src/cli/upgrade.ts"),
  link: () => import("@pinomad/host/src/cli/web-link.ts"),
  pair: () => import("@pinomad/host/src/cli/pair.ts"),
  join: () => import("@pinomad/host/src/cli/join.ts"),
  leave: () => import("@pinomad/host/src/cli/leave.ts"),
};

const USAGE = `pinomad — PiNomad host, server, and utilities

usage: pinomad <command> [args…]

  host [--data-dir DIR] [--port 7420] [--project DIR]…   run the host in the foreground
  host --remote-port PORT [--public-url URL]   remote access, LAN (ADR-0008)
  host --relay URL   remote access via relay (ADR-0015)
  host --faux "answer" [--faux-tps 40]   no real model, for tests
  server --public-origin O [--data-dir D] [--trust-proxy]   run the server
  server passwd [--data-dir D] [--user U]   reset an account's password (stdin)
  relay …                              old name of server
  service install|uninstall|status|restart|logs   user-level host service
  upgrade [--force] [address flags]    upgrade the package and restart the service
  link [--data-dir D|--url U …]        print the browser link
  pair [--data-dir D|--url U …]        print a pairing QR
  join <origin> <token> [--data-dir D] join this host to a server account
  leave [--data-dir D]                 leave the server account
  --version, -v                        print the version
`;

/** The subcommand's slice of the one usage table (`server` keeps both rows). */
function usageFor(command: string): string {
  const rows = USAGE.split("\n").filter((line) => line.startsWith(`  ${command} `));
  return `usage: pinomad ${command} [args…]\n${rows.join("\n")}`;
}

export async function main(argv: readonly string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (command === "--version" || command === "-v") {
    console.log(packagedVersion ?? "source");
    return;
  }
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    console.log(USAGE);
    return;
  }
  const load = COMMANDS[command];
  if (load === undefined) {
    console.error(`unknown command: ${command}`);
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  // No subcommand parser declares a help flag; intercept it here so e.g.
  // `upgrade --help` prints usage instead of starting work, and `host --help`
  // works even though host args pass straight through.
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(usageFor(command));
    return;
  }
  try {
    await (await load()).main(rest);
  } catch (error) {
    if (!isParseArgsError(error)) throw error;
    reportParseArgsError(`pinomad ${command}`, error);
  }
}

if (import.meta.main) await main(process.argv.slice(2));
