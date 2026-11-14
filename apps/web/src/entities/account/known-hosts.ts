// The account hosts this device has already told the user about (#496). A
// host confirmed on any device pairs everywhere on its own, so each device
// says "New host X joined your account" once per join: the user's chance to
// notice a machine they didn't add. A host removed and joined again is news
// again (#531), so an entry is `hostId@joinedAt`. A bare `hostId` (written
// before join times, or by a confirm on this device) stands for whichever
// join comes next. One set per account, kept in this renderer's
// localStorage; storage that fails just means no notices.
import { normalizeServerOrigin } from "@pinomad/client/account.ts";

export const KNOWN_HOSTS_KEY = "pinomad.knownAccountHosts.v2";
/**
 * The set from before join times: bare hostIds. Read once to seed the new
 * key, never written: a tab still running the old code keeps using it, and
 * entries it can't read would make it announce every host again (#531).
 */
export const LEGACY_KNOWN_HOSTS_KEY = "pinomad.knownAccountHosts";

export interface KnownHostsAccount {
  readonly serverOrigin: string;
  readonly user: string;
}

/** One account host as the list reports it; `joinedAt` is absent from servers before #531. */
export interface KnownHostJoin {
  readonly hostId: string;
  readonly joinedAt?: number;
}

export interface KnownHostsStore {
  /**
   * The hostIds whose current join this device hasn't announced, recorded as
   * known now. The first call for an account seeds its set and returns none.
   */
  arrivals(account: KnownHostsAccount, hosts: readonly KnownHostJoin[]): readonly string[];
  /** Marks a host's next join known without announcing it; only once the account's set exists. */
  add(account: KnownHostsAccount, hostId: string): void;
}

type KnownHostsStorage = Pick<Storage, "getItem" | "setItem">;

const entryOf = (host: KnownHostJoin): string =>
  host.joinedAt === undefined ? host.hostId : `${host.hostId}@${host.joinedAt}`;

const keyOf = (account: KnownHostsAccount): string =>
  `${normalizeServerOrigin(account.serverOrigin)}\u0000${account.user}`;

/** Every account's set; undefined when storage can't be read at all. */
const read = (storage: KnownHostsStorage): Record<string, string[]> | undefined => {
  let raw: string | null;
  try {
    // Until the first write, the old set's bare hostIds stand for each
    // host's current join.
    raw = storage.getItem(KNOWN_HOSTS_KEY) ?? storage.getItem(LEGACY_KNOWN_HOSTS_KEY);
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
    arrivals: (account, hosts) => {
      const sets = read(storage);
      if (sets === undefined) return [];
      const key = keyOf(account);
      const known = sets[key];
      if (known === undefined) {
        write(storage, { ...sets, [key]: hosts.map(entryOf) });
        return [];
      }
      let next = [...known];
      const arrived: string[] = [];
      for (const host of hosts) {
        const entry = entryOf(host);
        if (next.includes(entry)) {
          // A confirm here of a join already announced is spent: left
          // behind, it would hide the host's next join.
          if (host.joinedAt !== undefined) next = next.filter((each) => each !== host.hostId);
          continue;
        }
        const prefix = `${host.hostId}@`;
        // A bare entry covers this join, once; without join times, any
        // announced join of the host covers it.
        const covered =
          host.joinedAt === undefined ? next.some((each) => each.startsWith(prefix)) : next.includes(host.hostId);
        if (!covered) arrived.push(host.hostId);
        next = [...next.filter((each) => each !== host.hostId && !each.startsWith(prefix)), entry];
      }
      if (next.length !== known.length || next.some((each, index) => each !== known[index])) {
        write(storage, { ...sets, [key]: next });
      }
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
