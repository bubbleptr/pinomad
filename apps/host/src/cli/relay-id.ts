// `bun run relay-id` — print this host's relay identity (the Ed25519 public
// key as hostId) for the relay's `--allow-host`. Creates `<dataDir>/relay-key`
// on first run; safe beside a live host (loadRelayKey is single-writer).
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { relayHostId } from "@pinomad/protocol/relay.ts";
import { loadRelayKey } from "../devices.ts";
import { DEFAULT_DATA_DIR } from "./host-address.ts";

export async function relayId(argv: readonly string[]): Promise<string> {
  const { values } = parseArgs({
    args: [...argv],
    options: { "data-dir": { type: "string" } },
  });
  const dataDir = resolve(values["data-dir"] ?? DEFAULT_DATA_DIR);
  await mkdir(dataDir, { recursive: true });
  return relayHostId((await loadRelayKey(dataDir)).publicKey);
}

export async function main(argv: readonly string[]): Promise<void> {
  console.log(await relayId(argv));
}

if (import.meta.main) await main(process.argv.slice(2));
