#!/usr/bin/env node
// The published `pinomad` CLI (ADR-0016): one package holds the host, the
// relay, and the built web client. Subcommands load lazily so `pinomad pair`
// doesn't pay for the pi stack; bundled, each lazy import is a sibling chunk.
import { packagedVersion } from "@pinomad/host/src/distribution.ts";

type CommandModule = { main(argv: readonly string[]): Promise<void> };

const COMMANDS: Record<string, () => Promise<CommandModule>> = {
  host: () => import("@pinomad/host/src/main.ts"),
  relay: () => import("@pinomad/relay/src/main.ts"),
  service: () => import("@pinomad/host/src/cli/service.ts"),
  upgrade: () => import("@pinomad/host/src/cli/upgrade.ts"),
  link: () => import("@pinomad/host/src/cli/web-link.ts"),
  pair: () => import("@pinomad/host/src/cli/pair.ts"),
  join: () => import("@pinomad/host/src/cli/join.ts"),
  leave: () => import("@pinomad/host/src/cli/leave.ts"),
};

const USAGE = `pinomad — PiNomad host, relay, and utilities

usage: pinomad <command> [args…]

  host [host args…]                    run the host in the foreground
  relay --public-origin O [--data-dir D] [--trust-proxy]   run the server
  relay passwd [--data-dir D] [--user U]   change the account password (stdin)
  service install|uninstall|status|restart|logs   user-level host service
  upgrade [--force] [address flags]    upgrade the package and restart the service
  link [--data-dir D|--url U …]        print the browser link
  pair [--data-dir D|--url U …]        print a pairing QR
  join <origin> <token> [--data-dir D] join this host to a server account
  leave [--data-dir D]                 leave the server account
  --version, -v                        print the version
`;

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
  await (await load()).main(rest);
}

if (import.meta.main) await main(process.argv.slice(2));
