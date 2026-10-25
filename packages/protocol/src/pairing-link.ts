import { encodeEndpointSetParam, parseEndpointSetParam, type EndpointSet } from "./endpoints.ts";
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

/** A validated pairing link: the legacy socket plus the remote candidates, when the link carries a usable set. */
export interface ParsedPairingLink {
  readonly hostKey: string;
  readonly secret: string;
  readonly url: string;
  readonly endpointSet?: EndpointSet;
}

/**
 * Parse a pairing link — pasted, scanned, or arriving through a `pinomad://`
 * deep link — into the values the pairing flow needs.
 *
 * Accepts `http(s)://…#pair=…` (no `url` param → ws:// or wss:// + the
 * link's own host + `/`, never this page's origin) and `pinomad://pair#…`
 * (where `url` is required — pinomad has no usable origin). `url` must be a
 * ws:/wss: socket.
 *
 * `endpointSet` is optional and additive. A malformed set under the current
 * schema, an explicit empty set, or duplicate `endpointSet` parameters reject
 * the whole invite; an unknown schema or transport falls back to the legacy
 * `url`. Every other field (a smuggled `token=`, say) is dropped.
 */
export function parsePairingLink(pasted: string): ParsedPairingLink | undefined {
  let link: URL;
  try {
    link = new URL(pasted.trim());
  } catch {
    return undefined;
  }
  const params = new URLSearchParams(link.hash.replace(/^#/, ""));
  const pair = params.get("pair");
  const parsedPair = pair === null ? undefined : parsePairParam(pair);
  if (parsedPair === undefined) return undefined;
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
  const sets = params.getAll("endpointSet");
  if (sets.length > 1) return undefined;
  let endpointSet: EndpointSet | undefined;
  if (sets.length === 1) {
    const parsed = parseEndpointSetParam(sets[0]!);
    if (parsed.kind === "malformed") return undefined;
    if (parsed.kind === "valid") {
      // Pairing needs at least one remote path; an empty set is not a usable invite.
      if (parsed.endpointSet.endpoints.length === 0) return undefined;
      endpointSet = parsed.endpointSet;
    }
  }
  return {
    hostKey: parsedPair.hostKey,
    secret: parsedPair.secret,
    url,
    ...(endpointSet === undefined ? {} : { endpointSet }),
  };
}

/**
 * A pairing link normalized to the fragment resolveAddress reads.
 *
 * The output carries ONLY `pair=<k>.<s>&url=<encoded>`, plus a canonical
 * `endpointSet` when the link had a usable remote set. That is the additive
 * contract older clients ignore.
 */
export function pairingFragment(pasted: string): string | undefined {
  const parsed = parsePairingLink(pasted);
  if (parsed === undefined) return undefined;
  const endpointSet =
    parsed.endpointSet === undefined ? "" : `&endpointSet=${encodeEndpointSetParam(parsed.endpointSet)}`;
  return `pair=${parsed.hostKey}.${parsed.secret}&url=${encodeURIComponent(parsed.url)}${endpointSet}`;
}
