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
    if (new URL(pairing).hostname === "127.0.0.1") {
      // A QR is useless for a loopback link: a phone can't reach the host's
      // 127.0.0.1 (ADR-0020 §4). Say so instead of drawing one.
      console.log(pairing);
      console.log("This link only works on this machine — give it to the desktop app.");
      console.log("To pair a phone, restart the host with --remote-port or --relay, then run pair again.");
    } else {
      console.log(renderUnicodeCompact(pairing));
      console.log(pairing);
    }
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
