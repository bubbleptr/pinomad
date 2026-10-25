// Remote host endpoints (issue #347, ADR-0032): the small, ordered list of
// sockets a host publishes for its clients. This module only models and
// validates the set — dialing order, retries and persistence belong to the
// client layers, so both the browser and Node can import it.

/** The only endpoint-set schema this build understands. */
export const ENDPOINT_SET_SCHEMA_VERSION = 1 as const;

/** Upper bounds shared by every producer and consumer; generators must not truncate. */
export const MAX_HOST_ENDPOINTS = 4;
export const MAX_HOST_ENDPOINT_URL_LENGTH = 1024;

/**
 * The path role a socket plays. Transport is the wire protocol (only
 * WebSocket today), not the network that carries it — a Tailscale address is
 * still a direct WebSocket.
 */
export type HostEndpointRole = "direct" | "relay";

/** One socket the host publishes. Only WebSocket is supported today. */
export interface HostEndpoint {
  readonly transport: "webSocket";
  readonly role: HostEndpointRole;
  readonly url: string;
}

/** The host's remote candidates; an empty list means "no remote entry right now". */
export interface EndpointSet {
  readonly schemaVersion: typeof ENDPOINT_SET_SCHEMA_VERSION;
  readonly endpoints: readonly HostEndpoint[];
}

/**
 * How a raw endpoint set reads: missing, ignored because this build does not
 * know its schema or transports, malformed, or usable.
 *
 * Callers decide what each outcome means: pairing rejects a malformed or empty
 * invite, hello keeps its previous set on malformed/unsupported, and stored
 * hosts drop only the set.
 */
export type EndpointSetParse =
  | { readonly kind: "absent" }
  | { readonly kind: "unsupported" }
  | { readonly kind: "malformed" }
  | { readonly kind: "valid"; readonly endpointSet: EndpointSet };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isSocketUrl = (value: string): boolean => {
  if (value.length === 0) return false;
  try {
    const protocol = new URL(value).protocol;
    return protocol === "ws:" || protocol === "wss:";
  } catch {
    return false;
  }
};

/**
 * Validate an endpoint set from JSON. Unknown schema versions and sets with
 * no supported transport are ignored as a whole; a malformed set under the
 * current schema is rejected rather than partly adopted.
 */
export function parseEndpointSet(value: unknown): EndpointSetParse {
  if (value === undefined) return { kind: "absent" };
  if (!isRecord(value)) return { kind: "malformed" };
  const version = value.schemaVersion;
  if (typeof version !== "number") return { kind: "malformed" };
  if (version !== ENDPOINT_SET_SCHEMA_VERSION) return { kind: "unsupported" };
  const raw = value.endpoints;
  if (!Array.isArray(raw)) return { kind: "malformed" };
  if (raw.length > MAX_HOST_ENDPOINTS) return { kind: "malformed" };
  const endpoints: HostEndpoint[] = [];
  const roles = new Map<string, HostEndpointRole>();
  for (const entry of raw) {
    if (!isRecord(entry)) return { kind: "malformed" };
    const transport = entry.transport;
    if (typeof transport !== "string") return { kind: "malformed" };
    // A future transport is not a reason to reject the invite: keep the
    // entries this build can dial and let "no supported entry" mean unsupported.
    if (transport !== "webSocket") continue;
    const role = entry.role;
    if (role !== "direct" && role !== "relay") return { kind: "malformed" };
    const url = entry.url;
    if (typeof url !== "string" || url.length > MAX_HOST_ENDPOINT_URL_LENGTH) return { kind: "malformed" };
    if (!isSocketUrl(url)) return { kind: "malformed" };
    const prior = roles.get(url);
    if (prior !== undefined) {
      if (prior !== role) return { kind: "malformed" };
      continue;
    }
    roles.set(url, role);
    endpoints.push({ transport: "webSocket", role, url });
  }
  // No supported entry is not the same as an explicit empty set: the former
  // is a set this build cannot use, the latter is a host declaring no remote entry.
  if (endpoints.length === 0 && raw.length > 0) return { kind: "unsupported" };
  return { kind: "valid", endpointSet: { schemaVersion: ENDPOINT_SET_SCHEMA_VERSION, endpoints } };
}

/** Encode a set as the pairing link's `endpointSet` query value (compact JSON). */
export function encodeEndpointSetParam(endpointSet: EndpointSet): string {
  return encodeURIComponent(JSON.stringify(endpointSet));
}

/** Validate the pairing link's `endpointSet` value after URL decoding. */
export function parseEndpointSetParam(raw: string): EndpointSetParse {
  try {
    return parseEndpointSet(JSON.parse(raw));
  } catch {
    return { kind: "malformed" };
  }
}
