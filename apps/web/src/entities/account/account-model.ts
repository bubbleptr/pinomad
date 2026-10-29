// The account model for the web and desktop renderers (ADR-0022): detects how
// this client may reach the server-accounts API, holds the login state and the
// account's host list, and owns the actions. No components — the UI wires this
// store's state and calls.
import { useState, useSyncExternalStore } from "react";
import {
  createAccountClient,
  isSecureServerOrigin,
  isUnauthenticated,
  matchAccountHosts,
  normalizeServerOrigin,
  pairViaAccount,
  probeAccounts,
  type AccountClient,
  type AccountError,
  type AccountFetch,
  type AccountHostMatch,
  type AccountResult,
  type JoinToken,
  type PairConnectArgs,
} from "@pinomad/client/account.ts";
import { clientDeviceName } from "../../address.ts";
import type { DesktopBridge } from "../host/desktop-bridge.ts";
import { useHosts, type StoredHost } from "../host/host-store.ts";
import {
  browserDeclined,
  cancelAccountRegistration,
  onAccountRegistrationCancel,
  type DeclinedStore,
} from "./declined.ts";

/** How this client authenticates to the account API (ADR-0022 §2). */
export type AccountMode = "cookie" | "bearer";

/** The Web Locks surface the multi-tab registration guard needs. */
export interface AccountLocks {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

export type AccountState =
  | { readonly status: "checking" }
  /** The page's origin doesn't run accounts — a host's own port, a dev server, an accounts-less relay. */
  | { readonly status: "unavailable" }
  /**
   * Accounts are reachable but there's no live session. `serverOrigin` is the
   * known address to prefill — from a stored session or the last attempt.
   */
  | { readonly status: "signed-out"; readonly mode: AccountMode; readonly serverOrigin?: string }
  | {
      readonly status: "signed-in";
      readonly mode: AccountMode;
      readonly user: string;
      readonly serverOrigin: string;
      /** The account's hosts matched against stored pairings (packages/client matchAccountHosts). */
      readonly hosts: readonly AccountHostMatch[];
      /** The last refresh's failure; the previous list stays while it's set. */
      readonly hostsError?: AccountError;
      /**
       * hostKeys the host refused (4401): reported so the UI can offer an
       * explicit re-pair — the model never asks for an invite on its own.
       */
      readonly rejectedHostKeys: readonly string[];
      /**
       * Hosts the account pairing registered but whose save failed — the
       * device key dies with the page if it isn't persisted. One slot per
       * account hostId, so a multi-host round keeps every handshake.
       */
      readonly unsavedHosts: readonly StoredHost[];
    };

export interface AccountModel {
  readonly state: AccountState;
  subscribe(listener: () => void): () => void;
  /** Bearer mode needs `serverOrigin` unless a stored session already names one. */
  login(input: { username: string; password: string; serverOrigin?: string }): Promise<AccountResult<void>>;
  logout(): Promise<AccountResult<void>>;
  /** Revokes every session of the account including this one — always lands signed-out. */
  revokeAll(): Promise<AccountResult<void>>;
  refreshHosts(): Promise<AccountResult<readonly AccountHostMatch[]>>;
  createJoinToken(): Promise<AccountResult<JoinToken>>;
  /**
   * The explicit "pair this account host" action: vouched offer → the usual
   * IK pairing → persisted with its account link. It removes the host from the
   * declined set; automatic registration never does.
   */
  pairHost(hostId: string): Promise<AccountResult<StoredHost>>;
  /** Retry persisting one saved slot (or every slot) after a failed save. */
  retryUnsavedHost(hostId?: string): Promise<AccountResult<void>>;
  /** Mark a stored host's connection as refused by the host (4401). Pure bookkeeping. */
  hostRejected(hostKey: string): void;
}

export interface AccountModelDeps {
  /** The page's own origin — probed for the account API in cookie mode. */
  readonly origin: string;
  /** Present in the desktop renderer; selects bearer mode and token storage. */
  readonly bridge?: DesktopBridge;
  /** The paired-host store: refresh matches it, link adoption and re-pair cleanup write to it. */
  readonly hosts: {
    list(): Promise<StoredHost[]>;
    save(host: StoredHost): Promise<void>;
    remove(hostKey: string): Promise<void>;
  };
  /** Where a newly paired host lands — the hook wires the app's `paired`. */
  readonly paired: (host: StoredHost) => Promise<void>;
  readonly fetch?: AccountFetch;
  /** Device label for registrations; may resolve over the desktop bridge. */
  readonly name?: () => string | Promise<string>;
  /** pairViaAccount's transport seam — tests substitute a stub. */
  readonly connect?: (args: PairConnectArgs) => Promise<void>;
  /** Persisted declined identities; defaults to this renderer's localStorage set. */
  readonly declined?: DeclinedStore;
  /** Cross-tab registration lock; defaults to navigator.locks when available. */
  readonly locks?: AccountLocks;
  /** Test seam: turn automatic registration off for account-only cases. */
  readonly autoRegister?: boolean;
}

const fail = (code: string): AccountResult<never> => ({ ok: false, error: { code } });

/** Host refusals that mean "do not ask this host again on my behalf". */
const DECLINED_CODES = new Set(["pair_rejected", "disabled"]);

const browserLocks: AccountLocks | undefined =
  typeof navigator !== "undefined" && navigator.locks !== undefined
    ? {
        request: async (name, callback) => await navigator.locks.request(name, () => callback()),
      }
    : undefined;

const slotKey = (serverOrigin: string, hostId: string): string =>
  `${normalizeServerOrigin(serverOrigin)}\u0000${hostId}`;

const storedSlot = (host: StoredHost): string =>
  host.account === undefined
    ? host.hostKey
    : slotKey(host.account.serverOrigin, host.account.hostId);

export function createAccountModel(deps: AccountModelDeps): AccountModel {
  const listeners = new Set<() => void>();
  let state: AccountState = { status: "checking" };
  // The live client exists iff state is signed-in (or a login is in flight).
  let client: AccountClient | undefined;
  let mode: AccountMode = deps.bridge === undefined ? "cookie" : "bearer";
  let lastOrigin: string | undefined;
  const rejected = new Set<string>();
  const declined = deps.declined ?? browserDeclined;
  const autoRegisterEnabled = deps.autoRegister !== false;
  /** Save-failed identities, keyed by account hostId (or hostKey when unlinked). */
  const unsaved = new Map<string, StoredHost>();
  /** Bumped on sign-out and by an explicit cancel; flights compare it before acting. */
  let epoch = 0;
  interface Flight {
    cancelled: boolean;
    promise: Promise<void>;
  }
  const flights = new Map<string, Flight>();
  let stopVisibility: (() => void) | undefined;

  onAccountRegistrationCancel((hostId) => {
    for (const [key, flight] of flights) {
      if (hostId !== undefined && !key.endsWith(`\u0000${hostId}`)) continue;
      flight.cancelled = true;
      flights.delete(key);
    }
  });

  const setState = (next: AccountState): void => {
    state = next;
    for (const listener of listeners) listener();
  };

  const publishUnsaved = (): void => {
    if (state.status === "signed-in") setState({ ...state, unsavedHosts: [...unsaved.values()] });
  };

  const rememberUnsaved = (host: StoredHost): void => {
    unsaved.set(storedSlot(host), host);
    publishUnsaved();
  };

  const forgetUnsaved = (host: StoredHost): void => {
    if (unsaved.delete(storedSlot(host))) publishUnsaved();
  };

  const stopWatching = (): void => {
    stopVisibility?.();
    stopVisibility = undefined;
  };

  const signedOut = (): void => {
    client = undefined;
    epoch += 1;
    for (const flight of flights.values()) flight.cancelled = true;
    flights.clear();
    unsaved.clear();
    stopWatching();
    setState({
      status: "signed-out",
      mode,
      ...(lastOrigin === undefined ? {} : { serverOrigin: lastOrigin }),
    });
  };

  const signedInState = (
    active: AccountClient,
    user: string,
    hosts: readonly AccountHostMatch[],
    extra?: { hostsError?: AccountError },
  ): Extract<AccountState, { status: "signed-in" }> => ({
    status: "signed-in",
    mode,
    user,
    serverOrigin: active.origin,
    hosts,
    rejectedHostKeys: [...rejected],
    unsavedHosts: [...unsaved.values()],
    ...extra,
  });

  const live = (active: AccountClient, started: number): boolean => client === active && started === epoch;

  const deviceName = async (): Promise<string> => (deps.name ?? (() => "This device"))();

  /** Startup, login and every return to the foreground refresh the account hosts. */
  const watchVisibility = (): void => {
    if (stopVisibility !== undefined || typeof document === "undefined") return;
    const onVisibility = (): void => {
      if (document.visibilityState !== "visible") return;
      if (client !== undefined && state.status === "signed-in") void refresh(client, state.user);
    };
    document.addEventListener("visibilitychange", onVisibility);
    stopVisibility = () => document.removeEventListener("visibilitychange", onVisibility);
  };

  /** Save a slot without generating a new key; leaves it queued on failure. */
  const savePending = async (active: AccountClient, host: StoredHost): Promise<boolean> => {
    if (client !== active) return false;
    try {
      await deps.paired(host);
    } catch {
      return false;
    }
    forgetUnsaved(host);
    return true;
  };

  const retryPending = async (active: AccountClient): Promise<number> => {
    let saved = 0;
    for (const host of [...unsaved.values()]) {
      if (!(await savePending(active, host))) return saved;
      saved += 1;
    }
    return saved;
  };

  const handlePairFailure = (active: AccountClient, hostId: string, error: AccountError): void => {
    if (live(active, epoch) === false) return;
    if (isUnauthenticated(error)) {
      signedOut();
      return;
    }
    if (DECLINED_CODES.has(error.code)) {
      declined.add({ serverOrigin: active.origin, hostId });
    }
  };

  const accountName = (hostId: string): string | undefined =>
    state.status === "signed-in"
      ? state.hosts.find((match) => match.host.hostId === hostId)?.host.name
      : undefined;

  const enrich = (hostId: string, host: StoredHost): StoredHost => {
    const announced = accountName(hostId);
    return announced === undefined || announced === "" ? host : { ...host, name: announced };
  };

  const autoRegisterRound = async (
    active: AccountClient,
    user: string,
    matches: readonly AccountHostMatch[],
    storedRead: boolean,
  ): Promise<void> => {
    if (!autoRegisterEnabled || !storedRead) return;
    const recovered = await retryPending(active);
    if (!live(active, epoch)) return;
    if (recovered > 0) {
      // The saved slots change the matches; publish them before deciding what
      // else is eligible, without pairing anyone a second time.
      await refresh(active, user);
      return;
    }
    for (const match of matches) {
      if (!match.autoRegister) continue;
      const key = slotKey(active.origin, match.host.hostId);
      if (flights.has(key)) continue;
      const started = epoch;
      const flight: Flight = { cancelled: false, promise: Promise.resolve() };
      const run = async (): Promise<void> => {
        if (flight.cancelled || !live(active, started)) return;
        // The lock winner re-reads the list: another tab may have registered
        // while this one waited.
        const stored = await deps.hosts.list().catch(() => undefined);
        if (stored === undefined || flight.cancelled || !live(active, started)) return;
        const fresh = matchAccountHosts(active.origin, [match.host], stored, declined.list(), true)[0];
        if (fresh?.autoRegister !== true) {
          // Another tab won the lock and saved the pairing. Sync that record
          // into this page's runtime table even though this flight is done.
          if (fresh?.stored !== undefined) {
            await deps.paired(fresh.stored).catch((error: unknown) =>
              console.error("Could not sync a host paired by another tab", error),
            );
          }
          return;
        }
        const pending = unsaved.get(slotKey(active.origin, match.host.hostId));
        if (pending !== undefined) {
          if (await savePending(active, pending) && client === active) await refresh(active, user);
          return;
        }
        const result = await pairViaAccount(active, match.host.hostId, await deviceName(), deps.connect, {
          pageProtocol: window.location.protocol,
        });
        if (flight.cancelled || !live(active, started)) return;
        if (!result.ok) {
          handlePairFailure(active, match.host.hostId, result.error);
          return;
        }
        const enriched = enrich(match.host.hostId, result.value);
        try {
          await deps.paired(enriched);
        } catch {
          rememberUnsaved(enriched);
          return;
        }
        if (client === active) await refresh(active, user);
      };
      const promise = (async () => {
        const locks = deps.locks ?? browserLocks;
        if (locks === undefined) await run();
        else await locks.request(`pinomad.autoRegister:${normalizeServerOrigin(active.origin)}:${match.host.hostId}`, run);
      })().catch((error: unknown) => {
        console.error("Could not auto-register an account host", error);
      }).finally(() => {
        if (flights.get(key) === flight) flights.delete(key);
      });
      flight.promise = promise;
      flights.set(key, flight);
    }
  };

  const refresh = async (active: AccountClient, user: string): Promise<AccountResult<readonly AccountHostMatch[]>> => {
    const rows = await active.listHosts();
    // A slow response may land after logout or a newer login swapped the
    // client — publishing it would resurrect a dead session.
    if (client !== active) return { ok: false, error: { code: "stale" } };
    if (!rows.ok) {
      if (isUnauthenticated(rows.error)) {
        // The session is gone — the stored bearer is dead weight too.
        if (mode === "bearer") void deps.bridge?.account?.clear().catch(() => undefined);
        signedOut();
        return rows;
      }
      // A failed refresh keeps the session and the previous list.
      const previous = state.status === "signed-in" ? state.hosts : [];
      setState(signedInState(active, user, previous, { hostsError: rows.error }));
      return rows;
    }
    // A failed read is not an empty list: it keeps the matching verdicts but
    // makes every host ineligible for automatic registration until it works.
    let stored: readonly StoredHost[];
    let storedRead = true;
    try {
      stored = await deps.hosts.list();
    } catch {
      stored = [];
      storedRead = false;
    }
    if (client !== active) return { ok: false, error: { code: "stale" } };
    const matches = matchAccountHosts(active.origin, rows.value, stored, declined.list(), storedRead);
    // Adopt pre-account pairings: same Noise key, no link yet — bookkeeping,
    // not a re-pair, so a failed save is unremarkable.
    for (const match of matches) {
      if (match.linkable && match.stored !== undefined) {
        const host = match.stored;
        // Through `paired`, not the raw store: the app's in-memory list must
        // learn the account link too, or a later forget cannot decline it.
        void deps.paired({ ...host, account: { serverOrigin: active.origin, hostId: match.host.hostId } })
          .catch(() => undefined);
      }
    }
    setState(signedInState(active, user, matches));
    watchVisibility();
    void autoRegisterRound(active, user, matches, storedRead);
    return { ok: true, value: matches };
  };

  const init = async (): Promise<void> => {
    const bridge = deps.bridge;
    if (bridge !== undefined) {
      // Desktop: the session, if any, lives in main's encrypted store.
      const stored = await bridge.account?.get().catch(() => undefined);
      if (stored === undefined) {
        signedOut();
        return;
      }
      lastOrigin = stored.serverOrigin;
      const candidate = createAccountClient({
        origin: stored.serverOrigin,
        credentials: { mode: "bearer", token: stored.token },
        fetch: deps.fetch,
      });
      const me = await candidate.me();
      if (!me.ok) {
        if (isUnauthenticated(me.error)) void bridge.account?.clear().catch(() => undefined);
        signedOut();
        return;
      }
      client = candidate;
      await refresh(candidate, me.value.user.username);
      return;
    }
    // Browser: only a page the server itself serves may carry an account
    // session — a host port or a dev server answers /api/me with something
    // that isn't the API (probeAccounts owns the verdicts).
    if ((await probeAccounts(deps.origin, deps.fetch)) !== "enabled") {
      setState({ status: "unavailable" });
      return;
    }
    const candidate = createAccountClient({ origin: deps.origin, credentials: { mode: "cookie" }, fetch: deps.fetch });
    const me = await candidate.me();
    if (!me.ok) {
      lastOrigin = deps.origin;
      signedOut();
      return;
    }
    client = candidate;
    lastOrigin = deps.origin;
    await refresh(candidate, me.value.user.username);
  };
  void init();

  const pairHost = async (hostId: string): Promise<AccountResult<StoredHost>> => {
    if (client === undefined) return fail("unauthenticated");
    const active = client;
    declined.remove({ serverOrigin: active.origin, hostId });
    // An explicit join wins over an automatic round already in flight.
    cancelAccountRegistration(hostId);
    const pending = unsaved.get(slotKey(active.origin, hostId));
    if (pending !== undefined) {
      return (await savePending(active, pending)) ? { ok: true, value: pending } : fail("pairing_not_saved");
    }
    const result = await pairViaAccount(active, hostId, await deviceName(), deps.connect, {
      pageProtocol: window.location.protocol,
    });
    if (!result.ok) {
      handlePairFailure(active, hostId, result.error);
      return result;
    }
    const enriched = enrich(hostId, result.value);
    try {
      await deps.paired(enriched);
    } catch {
      // The invite is spent and the device registered — a failed save must
      // not orphan the key. Keep the record for retryUnsavedHost.
      rememberUnsaved(enriched);
      return fail("pairing_not_saved");
    }
    forgetUnsaved(enriched);
    // A re-pair after a key change stored a fresh record under the new key;
    // the stale linked record can never connect again — drop it so it stops
    // matching this account host.
    const stored = await deps.hosts.list().catch(() => [] as readonly StoredHost[]);
    for (const entry of stored) {
      if (
        entry.account !== undefined &&
        normalizeServerOrigin(entry.account.serverOrigin) === active.origin &&
        entry.account.hostId === hostId &&
        entry.hostKey !== enriched.hostKey
      ) {
        void deps.hosts.remove(entry.hostKey).catch(() => undefined);
      }
    }
    if (state.status === "signed-in" && client !== undefined) await refresh(client, state.user);
    return { ok: true, value: enriched };
  };

  return {
    get state() {
      return state;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    login: async ({ username, password, serverOrigin }) => {
      let candidate: AccountClient;
      if (mode === "cookie") {
        candidate = createAccountClient({ origin: deps.origin, credentials: { mode: "cookie" }, fetch: deps.fetch });
      } else {
        const origin = serverOrigin ?? lastOrigin;
        if (origin === undefined) return fail("origin_required");
        if (!isSecureServerOrigin(origin)) return fail("insecure_origin");
        candidate = createAccountClient({ origin, credentials: { mode: "bearer" }, fetch: deps.fetch });
      }
      const result = await candidate.login(username, password);
      if (!result.ok) return result;
      if (mode === "bearer") {
        if (result.value.token === undefined) return fail("invalid_response");
        candidate = createAccountClient({
          origin: candidate.origin,
          credentials: { mode: "bearer", token: result.value.token },
          fetch: deps.fetch,
        });
        lastOrigin = candidate.origin;
        // Persist after login succeeds; a bridge without account storage just
        // keeps this session in memory.
        void deps.bridge?.account
          ?.save({ serverOrigin: candidate.origin, token: result.value.token })
          .catch((error: unknown) => console.error("Could not persist the account session", error));
      }
      client = candidate;
      await refresh(candidate, result.value.user.username);
      return { ok: true, value: undefined };
    },

    logout: async () => {
      if (client === undefined) return fail("unauthenticated");
      const result = await client.logout();
      if (mode === "bearer") void deps.bridge?.account?.clear().catch(() => undefined);
      signedOut();
      return result.ok ? { ok: true, value: undefined } : result;
    },

    revokeAll: async () => {
      if (client === undefined) return fail("unauthenticated");
      const result = await client.revokeAllSessions();
      // revoke-all kills this session too — even on a network failure the
      // stored credential can't be trusted to survive, so clear it anyway.
      if (mode === "bearer") void deps.bridge?.account?.clear().catch(() => undefined);
      signedOut();
      return result.ok ? { ok: true, value: undefined } : result;
    },

    refreshHosts: async () => {
      if (client === undefined || state.status !== "signed-in") return fail("unauthenticated");
      return refresh(client, state.user);
    },

    createJoinToken: async () => {
      if (client === undefined) return fail("unauthenticated");
      const result = await client.createJoinToken();
      if (!result.ok && isUnauthenticated(result.error)) signedOut();
      return result;
    },

    pairHost,

    retryUnsavedHost: async (hostId) => {
      if (state.status !== "signed-in") return fail("nothing_pending");
      const wanted =
        hostId === undefined
          ? [...unsaved.values()]
          : [unsaved.get(slotKey(state.serverOrigin, hostId))].filter(
              (host): host is StoredHost => host !== undefined,
            );
      if (wanted.length === 0) return fail("nothing_pending");
      const active = client;
      if (active === undefined) return fail("unauthenticated");
      for (const host of wanted) {
        if (!(await savePending(active, host))) return fail("pairing_not_saved");
      }
      return { ok: true, value: undefined };
    },

    hostRejected: (hostKey) => {
      rejected.add(hostKey);
      if (state.status === "signed-in") setState({ ...state, rejectedHostKeys: [...rejected] });
    },
  };
}

/**
 * The app's account model, bound to the shared host store: `paired` persists
 * the host and adds its runtime; it never steals focus.
 */
export function useAccount(): AccountModel {
  const { store, paired } = useHosts();
  const [model] = useState(() =>
    createAccountModel({
      origin: window.location.origin,
      bridge: window.pinomadDesktop,
      hosts: store,
      paired,
      name: clientDeviceName,
    }),
  );
  useSyncExternalStore(model.subscribe, () => model.state);
  return model;
}
