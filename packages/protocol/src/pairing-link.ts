import { fromBase64Url } from "./secure-channel.ts";

/**
 * The `pair=<hostKey>.<secret>` fragment field: a 32-byte base64url host key
 * and a non-empty secret, separated by exactly one dot. Shared by
 * resolveAddress (fragment read off the page URL) and pairingFragment
 * (link pasted or delivered via deep link) so there is one rule.
 */
export function parsePairParam(pair: string): { hostKey: string; secret: string } | undefined {
  const dot = pair.indexOf(".");
  if (dot <= 0 || pair.indexOf(".", dot + 1) !== -1) return undefined;
  const hostKey = pair.slice(0, dot);
  const secret = pair.slice(dot + 1);
  try {
    if (fromBase64Url(hostKey).length !== 32 || fromBase64Url(secret).length === 0) return undefined;
  } catch {
    return undefined;
  }
  return { hostKey, secret };
}

/**
 * A pairing link — pasted into the client, or arriving through a
 * pinomad:// deep link — normalized to the fragment resolveAddress reads.
 *
 * Accepts `http(s)://…#pair=…` (no `url` param → ws:// or wss:// + the
 * link's own host + `/`, never this page's origin) and `pinomad://pair#…`
 * (where `url` is required — pinomad has no usable origin). `url` must be a
 * ws:/wss: socket.
 *
 * The output carries ONLY `pair=<k>.<s>&url=<encoded>`: every other field
 * (a smuggled `token=`, say — resolveAddress checks token before pair) is
 * dropped on the floor.
 */
export function pairingFragment(pasted: string): string | undefined {
  let link: URL;
  try {
    link = new URL(pasted.trim());
  } catch {
    return undefined;
  }
  const params = new URLSearchParams(link.hash.replace(/^#/, ""));
  const pair = params.get("pair");
  if (pair === null || pair === "" || parsePairParam(pair) === undefined) return undefined;
  let url = params.get("url");
  if (url === null || url === "") {
    if (link.protocol === "http:") url = `ws://${link.host}/`;
    else if (link.protocol === "https:") url = `wss://${link.host}/`;
    else return undefined;
  } else {
    try {
      const scheme = new URL(url).protocol;
      if (scheme !== "ws:" && scheme !== "wss:") return undefined;
    } catch {
      return undefined;
    }
  }
  return `pair=${pair}&url=${encodeURIComponent(url)}`;
}
