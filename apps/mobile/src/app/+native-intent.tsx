import { pairingFragment } from "@pinomad/protocol/pairing-link.ts";

/**
 * `pinomad://pair#<fragment>` is the only deep link the app accepts (same rule
 * as the desktop client): normalize it through the shared pairing-link rule and
 * land on the /pair confirm screen. Anything else goes to the index.
 */
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    const url = new URL(path);
    if (url.protocol === "pinomad:" && url.hostname === "pair") {
      const fragment = pairingFragment(path);
      return fragment === undefined ? "/pair" : `/pair?fragment=${encodeURIComponent(fragment)}`;
    }
  } catch {
    // fall through
  }
  return "/";
}
