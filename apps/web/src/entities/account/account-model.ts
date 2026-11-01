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
  type AccountDevice,
  type AccountDeviceClaim,
  type AccountError,
  type AccountFetch,
  type AccountHostMatch,
  type AccountInvite,
  type AccountResult,
  type CreatedInvite,
  type HostLinkRequest,
  type JoinToken,
  type LoginSuccess,
  type PairConnectArgs,
} from "@pinomad/client/account.ts";
import { accountDeviceName, clientDeviceName } from "../../address.ts";
import type { DesktopBridge } from "../host/desktop-bridge.ts";
import { useHosts, type StoredHost } from "../host/host-store.ts";
import {
  browserDeclined,
  cancelAccountRegistration,
  onAccountRegistrationCancel,
  type DeclinedStore,
} from "./declined.ts";
import { browserDeviceId } from "./device-id.ts";

/** How this client authenticates to the account API (ADR-0022 §2). */
export type AccountMode = "cookie" | "bearer";

/** The Web Locks surface the multi-tab registration guard needs. */
export interface AccountLocks {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

/** Foreground transitions; the model refreshes the account hosts on each. */
export interface AccountVisibility {
  subscribe(listener: () => void): () => void;
}

const browserVisibility: AccountVisibility = {
  subscribe(listener) {
    if (typeof document === "undefined") return () => {};
    const onVisibility = (): void => {
      if (document.visibilityState === "visible") listener();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  },
};

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
      /** The server's admin account, which mints sign-up invites (#449). */
      readonly admin: boolean;
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
  /** Creates an account from an invite and signs in, same origin rules as login (#449). */
  register(input: {
    invite: string;
    username: string;
    password: string;
    serverOrigin?: string;
  }): Promise<AccountResult<void>>;
  /**
   * Signs out; always lands signed-out, before the server answers. With
   * `revoke` (a shared computer, #494) the server also asks every host this
   * device joined through the account to revoke it, and this device forgets
   * the stored hosts linked to this server, with its keys for them. Hosts
   * paired by QR code stay. The forgetting doesn't wait on the server: an
   * older one ignores `revoke` and still answers 204.
   */
  logout(options?: { readonly revoke?: boolean }): Promise<AccountResult<void>>;
  /** Revokes every session of the account including this one — always lands signed-out. */
  revokeAll(): Promise<AccountResult<void>>;
  /** Signs out the account's other sessions; this one stays (#450). */
  changePassword(input: { currentPassword: string; newPassword: string }): Promise<AccountResult<void>>;
  /**
   * Deletes the account and lands signed-out (#451); a refusal or a failed
   * request keeps the session. Pairings stay: the device's registration on
   * each host is the host's to revoke.
   */
  deleteAccount(input: { password: string }): Promise<AccountResult<void>>;
  refreshHosts(): Promise<AccountResult<readonly AccountHostMatch[]>>;
  /** The account's devices (#452). */
  listDevices(): Promise<AccountResult<readonly AccountDevice[]>>;
  /**
   * Signs a device out of the account and asks its hosts to revoke it
   * (ADR-0037 §3). A refusal keeps this session; the caller reloads the list.
   */
  kickDevice(input: { id: number; password: string }): Promise<AccountResult<void>>;
  createJoinToken(): Promise<AccountResult<JoinToken>>;
  /**
   * The host waiting behind a code typed from its terminal (#496); the code
   * goes as typed. 404 `not_found` is a wrong, spent or expired code, 429
   * `rate_limited` the lockout after too many of those.
   */
  lookupHostLink(userCode: string): Promise<AccountResult<HostLinkRequest>>;
  /** Lets that host join the account; it then pairs like any account host. */
  confirmHostLink(userCode: string): Promise<AccountResult<void>>;
  /**
   * After a confirm here: refresh the account hosts right away and every 5 s
   * for up to 2 minutes, until `hostId` is listed and paired on this device.
   * The host joins only after its next poll, the join and a service restart,
   * and nothing else refreshes a page that already has a host. Sign-out
   * stops it; the UI that asked has no say, so closing it doesn't.
   */
  watchForHost(hostId: string): void;
  denyHostLink(userCode: string): Promise<AccountResult<void>>;
  /** Admin only (#449). */
  listInvites(): Promise<AccountResult<readonly AccountInvite[]>>;
  createInvite(): Promise<AccountResult<CreatedInvite>>;
  revokeInvite(id: number): Promise<AccountResult<void>>;
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
  /** Remove a superseded identity from the store and the app's runtime table, without declining it. */
  readonly removeHost?: (hostKey: string) => Promise<void>;
  readonly fetch?: AccountFetch;
  /** Device label for registrations; may resolve over the desktop bridge. */
  readonly name?: () => string | Promise<string>;
  /** This install's account device claim for login and sign-up (ADR-0037 §1); none when absent. */
  readonly device?: () => AccountDeviceClaim;
  /** pairViaAccount's transport seam — tests substitute a stub. */
  readonly connect?: (args: PairConnectArgs) => Promise<void>;
  /** Persisted declined identities; defaults to this renderer's localStorage set. */
  readonly declined?: DeclinedStore;
  /** Cross-tab registration lock; defaults to navigator.locks when available. */
  readonly locks?: AccountLocks;
  /** Foreground source; defaults to the document. */
  readonly visibility?: AccountVisibility;
  /** Test seam: turn automatic registration off for account-only cases. */
  readonly autoRegister?: boolean;
}

const fail = (code: string): AccountResult<never> => ({ ok: false, error: { code } });

/** watchForHost's pace: a refresh every 5 s, for 2 minutes. */
const HOST_WATCH_INTERVAL_MS = 5_000;
const HOST_WATCH_REFRESHES = 120_000 / HOST_WATCH_INTERVAL_MS;

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
  let admin = false;
  const rejected = new Set<string>();
  const declined = deps.declined ?? browserDeclined;
  const autoRegisterEnabled = deps.autoRegister !== false;
  /** Save-failed identities, keyed by account hostId (or hostKey when unlinked). */
  const unsaved = new Map<string, StoredHost>();
  /** Bumped on sign-out and by an explicit cancel; flights compare it before acting. */
  let epoch = 0;
  /**
   * A cookie-mode sign-out still waiting on the server. Its answer clears
   * the session cookie, so a sign-in waits for it rather than lose its own.
   */
  let pendingLogout: Promise<void> | undefined;
  interface Flight {
    cancelled: boolean;
    promise: Promise<void>;
  }
  const flights = new Map<string, Flight>();
  let stopVisibility: (() => void) | undefined;
  /** watchForHost's live watch per hostId, with its pending refresh between ticks. */
  const hostWatches = new Map<string, { readonly watch: object; readonly timer?: ReturnType<typeof setTimeout> }>();

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

  /** Ends the session's work: no client, every flight and pending save dropped. */
  const endSession = (): void => {
    client = undefined;
    admin = false;
    epoch += 1;
    for (const flight of flights.values()) flight.cancelled = true;
    flights.clear();
    unsaved.clear();
    stopWatching();
    for (const { timer } of hostWatches.values()) clearTimeout(timer);
    hostWatches.clear();
  };

  const publishSignedOut = (): void =>
    setState({
      status: "signed-out",
      mode,
      ...(lastOrigin === undefined ? {} : { serverOrigin: lastOrigin }),
    });

  const signedOut = (): void => {
    endSession();
    publishSignedOut();
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
    admin,
    serverOrigin: active.origin,
    hosts,
    rejectedHostKeys: [...rejected],
    unsavedHosts: [...unsaved.values()],
    ...extra,
  });

  const live = (active: AccountClient, started: number): boolean => client === active && started === epoch;

  /**
   * Drops every stored host linked to `origin`'s account, closing its
   * runtime, without declining it: the owner signing in here again later
   * should get those hosts back on their own (#494). False when any of them
   * may still be stored.
   */
  const forgetAccountHosts = async (origin: string): Promise<boolean> => {
    let stored: StoredHost[];
    try {
      stored = await deps.hosts.list();
    } catch (error) {
      console.error("Could not read the paired hosts to forget them", error);
      return false;
    }
    // Only keys the account issued: a QR pairing that later adopted the link
    // is the host's own, and stays.
    const vouched = (host: StoredHost): boolean =>
      host.account?.vouched === true && normalizeServerOrigin(host.account.serverOrigin) === origin;
    for (const host of stored.filter(vouched)) {
      await (deps.removeHost?.(host.hostKey) ?? deps.hosts.remove(host.hostKey)).catch((error: unknown) =>
        console.error("Could not forget a host", error),
      );
    }
    // The app's removal logs and swallows a store failure; read back to know.
    try {
      return !(await deps.hosts.list()).some(vouched);
    } catch (error) {
      console.error("Could not check the forgotten hosts", error);
      return false;
    }
  };

  const deviceName = async (): Promise<string> => (deps.name ?? (() => "This device"))();

  /** A successful registration is the end of a 4401 rejection for that host. */
  const clearRejected = (hostKey: string): void => {
    if (!rejected.delete(hostKey)) return;
    if (state.status === "signed-in") setState({ ...state, rejectedHostKeys: [...rejected] });
  };

  /** Startup, login and every return to the foreground refresh the account hosts. */
  const watchVisibility = (): void => {
    if (stopVisibility !== undefined) return;
    stopVisibility = (deps.visibility ?? browserVisibility).subscribe(() => {
      if (client !== undefined && state.status === "signed-in") void refresh(client, state.user);
    });
  };

  const declinedHost = (host: StoredHost): boolean =>
    host.account !== undefined
    && declined.list().some(
      (entry) =>
        normalizeServerOrigin(entry.serverOrigin) === normalizeServerOrigin(host.account!.serverOrigin)
        && entry.hostId === host.account!.hostId,
    );

  /** Save a slot without generating a new key; leaves it queued on failure. */
  const savePending = async (active: AccountClient, host: StoredHost): Promise<boolean> => {
    if (client !== active) return false;
    if (declinedHost(host)) {
      // The user forgot this host while its save was still failing; retrying
      // the save would resurrect it on the next foreground refresh.
      unsaved.delete(storedSlot(host));
      publishUnsaved();
      return false;
    }
    try {
      await deps.paired(host);
    } catch {
      return false;
    }
    clearRejected(host.hostKey);
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
            let synced = true;
            await deps.paired(fresh.stored).catch((error: unknown) => {
              synced = false;
              console.error("Could not sync a host paired by another tab", error);
            });
            // The local table is paired now; republish the match so the
            // account panel stops showing Pair for this host.
            if (synced && client === active) await refresh(active, user);
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
        clearRejected(enriched.hostKey);
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
      // A failed refresh keeps the session and the previous list. The
      // visibility watcher must still start: a recovered network should get a
      // chance to refresh and auto-register the account's hosts.
      const previous = state.status === "signed-in" ? state.hosts : [];
      setState(signedInState(active, user, previous, { hostsError: rows.error }));
      watchVisibility();
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
      admin = me.value.admin === true;
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
    admin = me.value.admin === true;
    await refresh(candidate, me.value.user.username);
  };
  void init();

  const pairHost = async (hostId: string): Promise<AccountResult<StoredHost>> => {
    if (client === undefined) return fail("unauthenticated");
    const active = client;
    const started = epoch;
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
    // Signed out while the handshake ran (a shared-computer sign-out may
    // already have forgotten this server's hosts): the key must not land.
    if (!live(active, started)) return fail("stale");
    const enriched = enrich(hostId, result.value);
    clearRejected(enriched.hostKey);
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
        // Removing through the app also drops the old runtime; the key change
        // is not a user decline, so it must not write the declined set.
        void (deps.removeHost?.(entry.hostKey) ?? deps.hosts.remove(entry.hostKey)).catch(() => undefined);
      }
    }
    if (state.status === "signed-in" && client !== undefined) await refresh(client, state.user);
    return { ok: true, value: enriched };
  };

  const watchForHost = (hostId: string): void => {
    if (client === undefined) return;
    const active = client;
    const started = epoch;
    // A second confirm of the same host starts its window over: the old
    // chain stops at its next step, even one waiting on a refresh.
    const watch = {};
    const previous = hostWatches.get(hostId);
    if (previous !== undefined) clearTimeout(previous.timer);
    hostWatches.set(hostId, { watch });
    const current = (): boolean => live(active, started) && hostWatches.get(hostId)?.watch === watch;
    const pairedHere = (): boolean =>
      state.status === "signed-in"
      && state.hosts.some((match) => match.host.hostId === hostId && match.status === "paired");
    const finish = (): void => {
      if (hostWatches.get(hostId)?.watch === watch) hostWatches.delete(hostId);
    };
    const tick = async (refreshesLeft: number): Promise<void> => {
      // The refresh that lists the host only starts its pairing; the one
      // after the pairing publishes it as paired, and the next tick sees that.
      if (!current() || state.status !== "signed-in" || pairedHere()) return finish();
      await refresh(active, state.user);
      if (!current()) return;
      if (pairedHere() || refreshesLeft === 0) return finish();
      hostWatches.set(hostId, { watch, timer: setTimeout(() => void tick(refreshesLeft - 1), HOST_WATCH_INTERVAL_MS) });
    };
    void tick(HOST_WATCH_REFRESHES);
  };

  /** Login and sign-up share everything but the call that mints the session. */
  const signIn = async (
    serverOrigin: string | undefined,
    call: (candidate: AccountClient) => Promise<AccountResult<LoginSuccess>>,
  ): Promise<AccountResult<void>> => {
    let candidate: AccountClient;
    if (mode === "cookie") {
      await pendingLogout;
      candidate = createAccountClient({ origin: deps.origin, credentials: { mode: "cookie" }, fetch: deps.fetch });
    } else {
      const origin = serverOrigin ?? lastOrigin;
      if (origin === undefined) return fail("origin_required");
      if (!isSecureServerOrigin(origin)) return fail("insecure_origin");
      candidate = createAccountClient({ origin, credentials: { mode: "bearer" }, fetch: deps.fetch });
    }
    const result = await call(candidate);
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
    admin = result.value.admin === true;
    await refresh(candidate, result.value.user.username);
    return { ok: true, value: undefined };
  };

  /**
   * An account call that signs out when the server says the session is gone.
   * `onSuccess` runs only while the session that made the call is current.
   */
  const authed = async <T,>(
    call: (active: AccountClient) => Promise<AccountResult<T>>,
    onSuccess?: () => void,
  ): Promise<AccountResult<T>> => {
    if (client === undefined) return fail("unauthenticated");
    const active = client;
    const started = epoch;
    const result = await call(active);
    // Signed out (and maybe into another account) while this ran: the answer
    // belongs to the old session and must not touch the new one.
    if (!live(active, started)) return result;
    if (result.ok) onSuccess?.();
    else if (isUnauthenticated(result.error)) signedOut();
    return result;
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

    login: ({ username, password, serverOrigin }) =>
      signIn(serverOrigin, (candidate) => candidate.login(username, password, deps.device?.())),

    register: ({ invite, username, password, serverOrigin }) =>
      signIn(serverOrigin, (candidate) => candidate.register(invite, username, password, deps.device?.())),

    logout: async (options) => {
      if (client === undefined) return fail("unauthenticated");
      const active = client;
      const revoke = options?.revoke === true;
      // The session's work stops before anything is awaited: no refresh or
      // registration can bring back a host being forgotten.
      endSession();
      if (mode === "bearer") {
        // A bearer sign-out's answer can't touch a newer session: that one
        // carries its own token and no cookie. Show the sign-in form now.
        void deps.bridge?.account?.clear().catch(() => undefined);
        publishSignedOut();
      } else {
        // In cookie mode the answer clears the session cookie, and a login
        // made before it lands would lose its own. Hold the form back until
        // the request settles.
        setState({ status: "checking" });
      }
      const settled = (async () => ({
        forgotten: revoke ? await forgetAccountHosts(active.origin) : true,
        result: await active.logout(revoke ? { revoke: true } : undefined),
      }))();
      const waited = settled.then(() => undefined);
      if (mode === "cookie") pendingLogout = waited;
      const { forgotten, result } = await settled;
      if (pendingLogout === waited) pendingLogout = undefined;
      if (mode === "cookie" && client === undefined && state.status === "checking") publishSignedOut();
      // A host still stored here is the bigger worry: this device can still
      // connect to it whatever the server did.
      if (!forgotten) return fail("hosts_not_forgotten");
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

    changePassword: ({ currentPassword, newPassword }) =>
      authed((active) => active.changePassword(currentPassword, newPassword)),
    // Unlike revokeAll, a failure keeps the session: the account may still exist.
    deleteAccount: ({ password }) =>
      authed(
        (active) => active.deleteAccount(password),
        () => {
          if (mode === "bearer") void deps.bridge?.account?.clear().catch(() => undefined);
          signedOut();
        },
      ),
    listDevices: () => authed((active) => active.listDevices()),
    kickDevice: ({ id, password }) => authed((active) => active.kickDevice(id, password)),
    createJoinToken: () => authed((active) => active.createJoinToken()),
    lookupHostLink: (userCode) => authed((active) => active.lookupHostLink(userCode)),
    confirmHostLink: (userCode) => authed((active) => active.confirmHostLink(userCode)),
    denyHostLink: (userCode) => authed((active) => active.denyHostLink(userCode)),
    watchForHost,
    listInvites: () => authed((active) => active.listInvites()),
    createInvite: () => authed((active) => active.createInvite()),
    revokeInvite: (id) => authed((active) => active.revokeInvite(id)),

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
  const { store, paired, dropHost } = useHosts();
  const [model] = useState(() =>
    createAccountModel({
      origin: window.location.origin,
      bridge: window.pinomadDesktop,
      hosts: store,
      paired,
      removeHost: dropHost,
      name: clientDeviceName,
      device: () => ({
        id: browserDeviceId(),
        name: accountDeviceName(navigator.userAgent, document.documentElement.dataset.pinomadPlatform),
      }),
    }),
  );
  useSyncExternalStore(model.subscribe, () => model.state);
  return model;
}
