// `bun run pair` — print a pairing QR for a new device. Connects to the local
// host with its token, asks for a one-time offer, and shows the link. The QR
// scans into the web client served by the host's remote listener (ADR-0008).
import { renderUnicodeCompact } from "uqr";
import { connectRemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import { hostAddress } from "./host-address.ts";

const { url, token } = await hostAddress(process.argv.slice(2));

let remote;
try {
  remote = await connectRemoteDurable({ url, token, reconnectDelayMs: { min: 200, max: 2000 } });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

try {
  const { url: pairing, expiresAt } = await remote.controller.createPairing();
  console.log(renderUnicodeCompact(pairing));
  console.log(pairing);
  console.log(`Expires at ${new Date(expiresAt).toLocaleTimeString()}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  remote.close();
  process.exit(1);
}
remote.close();
process.exit(0);
