import { pairingFragment } from "@pinomad/protocol/pairing-link.ts";

/**
 * `pinomad://pair#<fragment>` — the only deep link the app accepts — is
 * normalized through the shared pairing-link rule: the window loads the
 * emitted `pair=…&url=…` fragment and nothing else (a `token=` smuggled in
 * the raw hash is dropped, never reaching resolveAddress's token branch).
 */
export function pairingFragmentFromDeepLink(link: string): string | undefined {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return undefined;
  }
  if (url.protocol !== "pinomad:" || url.hostname !== "pair") return undefined;
  return pairingFragment(link);
}
