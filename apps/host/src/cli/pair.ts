// `bun run pair` — print a pairing QR for a new device. Connects to the local
// host with its token, asks for a one-time offer, and shows the link. The QR
// scans into the web client served by the host's remote listener (ADR-0008);
// a host without remote access prints a loopback link instead, usable only by
// clients on this machine (ADR-0020).
import { renderUnicodeCompact } from "uqr";
import { connectRemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import { hostAddress } from "./host-address.ts";

/** Fetch a one-time pairing offer from the host and print it as a QR + URL. */
export async function printPairing({ url, token }: { url: string; token: string }): Promise<void> {
  const remote = await connectRemoteDurable({ url, token, reconnectDelayMs: { min: 200, max: 2000 } });
  try {
    const { url: pairing, expiresAt } = await remote.controller.createPairing();
    console.log(renderUnicodeCompact(pairing));
    console.log(pairing);
    console.log(`Expires at ${new Date(expiresAt).toLocaleTimeString()}`);
  } finally {
    remote.close();
  }
}

export async function main(argv: readonly string[]): Promise<void> {
  const { url, token } = await hostAddress(argv);
  try {
    await printPairing({ url, token });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

if (import.meta.main) await main(process.argv.slice(2));
