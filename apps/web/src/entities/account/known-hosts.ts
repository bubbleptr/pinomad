// The account hosts this device has already told the user about (#496). A
// host confirmed on any device pairs everywhere on its own, so each device
// says "New host X joined your account" once: the user's chance to notice a
// machine they didn't add. One set per account, kept in this renderer's
// localStorage; storage that fails just means no notices.
import { normalizeServerOrigin } from "@pinomad/client/account.ts";

export const KNOWN_HOSTS_KEY = "pinomad.knownAccountHosts";

export interface KnownHostsAccount {
  readonly serverOrigin: string;
  readonly user: string;
}

export interface KnownHostsStore {
  /**
   * The hostIds in `hostIds` this device hasn't announced, recorded as known
   * now. The first call for an account seeds its set and returns none.
   */
  arrivals(account: KnownHostsAccount, hostIds: readonly string[]): readonly string[];
  /** Marks a host known without announcing it; only once the account's set exists. */
  add(account: KnownHostsAccount, hostId: string): void;
}

type KnownHostsStorage = Pick<Storage, "getItem" | "setItem">;

const keyOf = (account: KnownHostsAccount): string =>
  `${normalizeServerOrigin(account.serverOrigin)}\u0000${account.user}`;

/** Every account's set; undefined when storage can't be read at all. */
const read = (storage: KnownHostsStorage): Record<string, string[]> | undefined => {
  let raw: string | null;
  try {
    raw = storage.getItem(KNOWN_HOSTS_KEY);
  } catch {
    return undefined;
  }
  if (raw === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const sets: Record<string, string[]> = {};
  for (const [key, ids] of Object.entries(parsed)) {
    if (Array.isArray(ids)) sets[key] = ids.filter((id): id is string => typeof id === "string");
  }
  return sets;
};

const write = (storage: KnownHostsStorage, sets: Record<string, string[]>): void => {
  try {
    storage.setItem(KNOWN_HOSTS_KEY, JSON.stringify(sets));
  } catch (error) {
    console.error("Could not save the known account hosts", error);
  }
};

export function createKnownHostsStore(storage: KnownHostsStorage = localStorage): KnownHostsStore {
  return {
    arrivals: (account, hostIds) => {
      const sets = read(storage);
      if (sets === undefined) return [];
      const key = keyOf(account);
      const known = sets[key];
      if (known === undefined) {
        write(storage, { ...sets, [key]: [...hostIds] });
        return [];
      }
      const arrived = hostIds.filter((id) => !known.includes(id));
      if (arrived.length > 0) write(storage, { ...sets, [key]: [...known, ...arrived] });
      return arrived;
    },
    add: (account, hostId) => {
      const sets = read(storage);
      const known = sets?.[keyOf(account)];
      if (sets === undefined || known === undefined || known.includes(hostId)) return;
      write(storage, { ...sets, [keyOf(account)]: [...known, hostId] });
    },
  };
}

/** The renderer's set, shared by the confirm page and the notices. */
export const browserKnownHosts = createKnownHostsStore();
