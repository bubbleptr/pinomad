/**
 * `pinomad://pair#<fragment>` — the only deep link the app accepts — carries
 * the same fragment a printed pairing URL carries; anything else is dropped
 * before it can touch the window.
 */
export function pairingFragmentFromDeepLink(link: string): string | undefined {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return undefined;
  }
  if (url.protocol !== "pinomad:" || url.hostname !== "pair") return undefined;
  const fragment = url.hash.replace(/^#/, "");
  const pair = new URLSearchParams(fragment).get("pair");
  if (pair === null || pair === "") return undefined;
  return fragment;
}
