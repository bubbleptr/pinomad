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
  type AccountConfirmation,
  type AccountDevice,
  type AccountDeviceClaim,
  type AccountError,
  type AccountFetch,
  type AccountHostMatch,
  type AccountIdentities,
  type AccountProfile,
  type AccountResult,
  type AuthMethods,
  type EmailConfirmation,
  type HostLinkRequest,
  type JoinToken,
  type LoginSuccess,
  type PairConnectArgs,
  type PendingOutcome,
  type PendingSignIn,
  type ReauthGrant,
} from "@pinomad/client/account.ts";
import { toBase64Url } from "@pinomad/protocol/secure-channel.ts";
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
      /** What to show for the account: its email, or a legacy username. */
      readonly user: string;
      /** The account's verified email; absent on legacy accounts that have none yet. */
      readonly email?: string;
      /**
       * A legacy account the server wants an email for before anything else
       * (ADR-0044 §8): the app shows the add-email card instead of itself.
       */
      readonly needsEmail?: true;
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
  /**
   * Signs out the account's other sessions; this one stays (#450). A re-auth
   * grant sets a first password on an account that has none (ADR-0044 §6).
   */
  changePassword(input: { confirmation: AccountConfirmation; newPassword: string }): Promise<AccountResult<void>>;
  /**
   * Deletes the account and lands signed-out (#451); a refusal or a failed
   * request keeps the session. Pairings stay: the device's registration on
   * each host is the host's to revoke.
   */
  deleteAccount(input: { confirmation: AccountConfirmation }): Promise<AccountResult<void>>;
  /**
   * How provider sign-in works here (ADR-0044 §5): "redirect" on the page
   * the server serves (the whole page goes to the provider), "loopback" in
   * the desktop app (the system browser, back to a 127.0.0.1 listener), and
   * none where neither can.
   */
  readonly providerFlow: "redirect" | "loopback" | undefined;
  /** What the server offers: sign-up, mailed codes, providers. Bearer mode asks `serverOrigin`. */
  authMethods(serverOrigin?: string): Promise<AccountResult<AuthMethods>>;
  requestSignupCode(input: { email: string; serverOrigin?: string }): Promise<AccountResult<void>>;
  /** Creates the account from the mailed code and signs it in, like login. */
  register(input: { email: string; code: string; password: string; serverOrigin?: string }): Promise<AccountResult<void>>;
  requestPasswordReset(input: { email: string; serverOrigin?: string }): Promise<AccountResult<void>>;
  /** Sets the new password; the account is signed out everywhere and signs in again. */
  resetPassword(input: { email: string; code: string; password: string; serverOrigin?: string }): Promise<AccountResult<void>>;
  /**
   * Signs in with a provider: a "redirect" page leaves for the server's start
   * route and the promise never settles; "loopback" opens the system browser
   * and signs in with the code it brings back.
   */
  providerSignIn(input: { provider: string; serverOrigin?: string }): Promise<AccountResult<void>>;
  /** Mails a code to the email the signed-in account wants to use. */
  requestEmailCode(input: { email: string } & EmailConfirmation): Promise<AccountResult<void>>;
  /** Makes it the account's email; ends the needsEmail hold. */
  setEmail(input: { email: string; code: string } & EmailConfirmation): Promise<AccountResult<void>>;
  identities(): Promise<AccountResult<AccountIdentities>>;
  requestReauthCode(): Promise<AccountResult<void>>;
  reauth(proof: { password: string } | { code: string }): Promise<AccountResult<ReauthGrant>>;
  /**
   * Adds a provider to the signed-in account (ADR-0044 §4). "redirect":
   * the provider page to send this browser to, which comes back with
   * `?oauth_linked=` or `?oauth_error=`. "loopback" (#631): the system
   * browser does it and this settles once the provider is linked.
   */
  linkProvider(provider: string, confirmation: AccountConfirmation): Promise<AccountResult<{ readonly redirect?: string }>>;
  unlinkProvider(provider: string, confirmation: AccountConfirmation): Promise<AccountResult<void>>;
  /** The provider sign-in behind `?oauth_pending=`, read on this page's own server. */
  pendingSignIn(id: string): Promise<AccountResult<PendingSignIn>>;
  /**
   * Creates the account a pending sign-in asked for. This page is then signed
   * in to it, unless a native app started the sign-in: then `redirect` is
   * where the browser goes next, and this page stays as it was.
   */
  createFromPending(id: string, options?: { password?: string }): Promise<AccountResult<{ redirect?: string }>>;
  /** Adds a pending sign-in's provider to the signed-in account. */
  linkPending(id: string, confirmation: AccountConfirmation): Promise<AccountResult<{ redirect?: string }>>;
  /** Signs in with the password, then links with that same password as the confirmation. */
  signInAndLinkPending(id: string, input: { username: string; password: string }): Promise<AccountResult<{ redirect?: string }>>;
  refreshHosts(): Promise<AccountResult<readonly AccountHostMatch[]>>;
  /** The account's devices (#452). */
  listDevices(): Promise<AccountResult<readonly AccountDevice[]>>;
  /**
   * Signs a device out of the account and asks its hosts to revoke it
   * (ADR-0037 §3). A refusal keeps this session; the caller reloads the list.
   */
  kickDevice(input: { id: number; confirmation: AccountConfirmation }): Promise<AccountResult<void>>;
  /**
   * Takes a host off the account (#512), with the password as for a kick: it
   * stops connecting through the server until `pinomad up` runs on it again.
   * This device then forgets the key the account gave it for that host; a QR
   * pairing stays. A 404 refreshes the list: a host still on it means a
   * server that can't remove hosts (`remove_unsupported`), otherwise it was
   * already gone and this device forgets it just the same.
   */
  removeHost(input: { hostId: string; confirmation: AccountConfirmation }): Promise<AccountResult<void>>;
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
  /**
   * A loopback host link (#513): the host behind the request id in the
   * confirm URL. Confirm and deny answer where to send the browser, the
   * host's own `http://127.0.0.1` listener; nothing else gets through.
   */
  lookupHostLinkRequest(requestId: string): Promise<AccountResult<HostLinkRequest>>;
  confirmHostLinkRequest(requestId: string): Promise<AccountResult<string>>;
  denyHostLinkRequest(requestId: string): Promise<AccountResult<string>>;
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
  /** Where a "redirect" provider sign-in sends the page; defaults to location.assign. */
  readonly navigate?: (url: string) => void;
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
  const providerFlow =
    mode === "cookie" ? ("redirect" as const) : deps.bridge?.oauthSignIn !== undefined ? ("loopback" as const) : undefined;
  let lastOrigin: string | undefined;
  /** The signed-in account's email and needsEmail flag, as its last profile said. */
  let profile: Pick<Extract<AccountState, { status: "signed-in" }>, "email" | "needsEmail"> = {};
  const takeProfile = (value: AccountProfile): void => {
    profile = {
      ...(value.user.email === undefined ? {} : { email: value.user.email }),
      ...(value.needsEmail === true ? { needsEmail: true as const } : {}),
    };
  };
  const rejected = new Set<string>();
  const declined = deps.declined ?? browserDeclined;
  const autoRegisterEnabled = deps.autoRegister !== false;
  /** Save-failed identities, keyed by account hostId (or hostKey when unlinked). */
  const unsaved = new Map<string, StoredHost>();
  /**
   * Bumped only when a session ends (endSession); flights compare it before
   * acting. An explicit cancel sets `flight.cancelled` and leaves it alone.
   */
  let epoch = 0;
  /**
   * Bumped by every sign-in attempt and every session end. A sign-in whose
   * number moved on while it waited (a slow system-browser flow overtaken by
   * a password login, a sign-out) drops its result instead of adopting it.
   */
  let attempt = 0;
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
  /**
   * Removals this page made, per account host slot. A pairing that started
   * before one must neither store the host it took off the account nor queue
   * it for a retry when its save fails; a save that lands after it is taken
   * back, since the removal's forget may have run first.
   */
  const removals = new Map<string, number>();
  /** Counts refresh() calls, so a slower, older list can tell it was overtaken. */
  let refreshes = 0;
  const removedSince = (slot: string, seen: number | undefined): boolean => removals.get(slot) !== seen;
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
    attempt += 1;
    profile = {};
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
    ...profile,
    serverOrigin: active.origin,
    hosts,
    rejectedHostKeys: [...rejected],
    unsavedHosts: [...unsaved.values()],
    ...extra,
  });

  // A new state, cookie or key write after an await should record `const
  // started = epoch` before the await and check `live(active, started)` after
  // it. The older checks that only compare `client === active` are equivalent
  // because endSession both clears `client` and bumps `epoch`, and every
  // sign-in installs a freshly created client.
  const live = (active: AccountClient, started: number): boolean => client === active && started === epoch;

  /**
   * Drops every stored host linked to `origin`'s account (or only `hostId`),
   * closing its runtime, without declining it: the owner signing in here
   * again later should get those hosts back on their own (#494). False when
   * any of them may still be stored.
   */
  const forgetAccountHosts = async (origin: string, hostId?: string): Promise<boolean> => {
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
      host.account?.vouched === true
      && normalizeServerOrigin(host.account.serverOrigin) === origin
      && (hostId === undefined || host.account.hostId === hostId);
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
    const slot = storedSlot(host);
    const seen = removals.get(slot);
    try {
      await deps.paired(host);
    } catch {
      return false;
    }
    if (host.account !== undefined && removedSince(slot, seen)) {
      await forgetAccountHosts(active.origin, host.account.hostId);
      return false;
    }
    clearRejected(host.hostKey);
    forgetUnsaved(host);
    return true;
  };

  const retryPending = async (active: AccountClient): Promise<number> => {
    let saved = 0;
    for (const host of [...unsaved.values()]) {
      // Left the queue while an earlier save ran (its host removed, saved by
      // another round, the session ended): saving it now would bring it back.
      if (unsaved.get(storedSlot(host)) !== host) continue;
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
      const removed = removals.get(key);
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
          if (!removedSince(key, removed)) rememberUnsaved(enriched);
          return;
        }
        if (removedSince(key, removed)) {
          await forgetAccountHosts(active.origin, match.host.hostId);
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
    const started = (refreshes += 1);
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
    // Hosts that left the account (removed on another device, or `pinomad
    // leave`): this device lets go of them as a removal here does, or every
    // runtime keeps dialing a host the relay will never connect it to.
    const listed = new Set(rows.value.map((row) => row.hostId));
    const before = state.status === "signed-in" && state.serverOrigin === active.origin ? state.hosts : [];
    const delisted = new Set([
      ...before.map((match) => match.host.hostId),
      ...stored.flatMap((host) =>
        host.account?.vouched === true && normalizeServerOrigin(host.account.serverOrigin) === active.origin
          ? [host.account.hostId]
          : [],
      ),
    ].filter((hostId) => !listed.has(hostId)));
    setState(signedInState(active, user, matches));
    watchVisibility();
    void autoRegisterRound(active, user, matches, storedRead);
    // Only the newest refresh may forget: an older list answered before a host
    // joined would drop the pairing a newer refresh just saved.
    if (started === refreshes) {
      for (const hostId of delisted) await forgetRemovedHost(active.origin, hostId);
    }
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
      takeProfile(me.value);
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
    takeProfile(me.value);
    await refresh(candidate, me.value.user.username);
  };
  void init();

  const pairHost = async (hostId: string): Promise<AccountResult<StoredHost>> => {
    if (client === undefined) return fail("unauthenticated");
    const active = client;
    const started = epoch;
    const slot = slotKey(active.origin, hostId);
    const removed = removals.get(slot);
    declined.remove({ serverOrigin: active.origin, hostId });
    // An explicit join wins over an automatic round already in flight.
    cancelAccountRegistration(hostId);
    const pending = unsaved.get(slot);
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
    // Removed from the account while the handshake ran: storing the key
    // would bring the host back on this device.
    if (removedSince(slot, removed)) return fail("host_removed");
    const enriched = enrich(hostId, result.value);
    clearRejected(enriched.hostKey);
    try {
      await deps.paired(enriched);
    } catch {
      if (removedSince(slot, removed)) return fail("host_removed");
      // The invite is spent and the device registered — a failed save must
      // not orphan the key. Keep the record for retryUnsavedHost.
      rememberUnsaved(enriched);
      return fail("pairing_not_saved");
    }
    if (removedSince(slot, removed)) {
      await forgetAccountHosts(active.origin, hostId);
      return fail("host_removed");
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

  /**
   * The account no longer has `hostId`, so this device lets go of it: nothing
   * may pair it again (an automatic flight or a manual pairing in progress, a
   * failed save waiting for its retry, a watch after a confirm), and the key
   * the account gave this device goes. A failure to forget is logged there;
   * the server side is done, and the host stops answering through it either way.
   */
  const forgetRemovedHost = async (origin: string, hostId: string): Promise<void> => {
    const slot = slotKey(origin, hostId);
    removals.set(slot, (removals.get(slot) ?? 0) + 1);
    cancelAccountRegistration(hostId);
    if (unsaved.delete(slot)) publishUnsaved();
    clearTimeout(hostWatches.get(hostId)?.timer);
    hostWatches.delete(hostId);
    await forgetAccountHosts(origin, hostId);
  };

  const removeHost = async ({
    hostId,
    confirmation,
  }: {
    hostId: string;
    confirmation: AccountConfirmation;
  }): Promise<AccountResult<void>> => {
    if (client === undefined || state.status !== "signed-in") return fail("unauthenticated");
    const active = client;
    const started = epoch;
    const user = state.user;
    const result = await active.removeHost(hostId, confirmation);
    if (!live(active, started)) return result;
    if (!result.ok) {
      if (isUnauthenticated(result.error)) signedOut();
      else if (result.error.code === "not_found") {
        // Removed earlier (from another device, or a retry after a lost 204),
        // or a server that predates removal (also 404): the list says which.
        // A failed refresh proves neither, so its error keeps the form open.
        const listed = await refresh(active, user);
        if (!listed.ok) return listed;
        if (listed.value.some((match) => match.host.hostId === hostId)) return fail("remove_unsupported");
        // Gone from the account: this device forgets it as after a 204. The
        // list just read already leaves it out, so no second refresh.
        await forgetRemovedHost(active.origin, hostId);
        return { ok: true, value: undefined };
      }
      return result;
    }
    await forgetRemovedHost(active.origin, hostId);
    if (live(active, started)) await refresh(active, user);
    return { ok: true, value: undefined };
  };

  /**
   * A client with no session yet, for the calls before one: this page's own
   * server in cookie mode, the typed (or last) server in bearer mode, which
   * must be TLS.
   */
  const anonymous = (serverOrigin: string | undefined): AccountResult<AccountClient> => {
    if (mode === "cookie") {
      return { ok: true, value: createAccountClient({ origin: deps.origin, credentials: { mode: "cookie" }, fetch: deps.fetch }) };
    }
    const origin = serverOrigin ?? lastOrigin;
    if (origin === undefined) return fail("origin_required");
    if (!isSecureServerOrigin(origin)) return fail("insecure_origin");
    return { ok: true, value: createAccountClient({ origin, credentials: { mode: "bearer" }, fetch: deps.fetch }) };
  };

  const beforeSession = async <T,>(
    serverOrigin: string | undefined,
    call: (candidate: AccountClient) => Promise<AccountResult<T>>,
  ): Promise<AccountResult<T>> => {
    const candidate = anonymous(serverOrigin);
    return candidate.ok ? call(candidate.value) : candidate;
  };

  /** Login, sign-up and provider sign-in share everything but the call that mints the session. */
  const signIn = async (
    serverOrigin: string | undefined,
    call: (candidate: AccountClient) => Promise<AccountResult<LoginSuccess>>,
    /** The attempt this call continues; a fresh one when absent. */
    started: number = ++attempt,
  ): Promise<AccountResult<void>> => {
    const before = client;
    if (mode === "cookie") await pendingLogout;
    const built = anonymous(serverOrigin);
    if (!built.ok) return built;
    const result = await call(built.value);
    if (!result.ok) return result;
    if (superseded(started, before)) return fail("superseded");
    return adopt(built.value, result.value);
  };

  /** Another sign-in or a sign-out happened since `started`, or a session this attempt didn't make is up. */
  const superseded = (started: number, before: AccountClient | undefined): boolean => attempt !== started || client !== before;

  /** Makes a fresh session this model's: stored in bearer mode, hosts refreshed. */
  const adopt = async (anonymousClient: AccountClient, login: LoginSuccess): Promise<AccountResult<void>> => {
    let candidate = anonymousClient;
    if (mode === "bearer") {
      if (login.token === undefined) return fail("invalid_response");
      candidate = createAccountClient({
        origin: candidate.origin,
        credentials: { mode: "bearer", token: login.token },
        fetch: deps.fetch,
      });
      lastOrigin = candidate.origin;
      // Persist after login succeeds; a bridge without account storage just
      // keeps this session in memory.
      void deps.bridge?.account
        ?.save({ serverOrigin: candidate.origin, token: login.token })
        .catch((error: unknown) => console.error("Could not persist the account session", error));
    }
    // A sign-in over a live session (a pending sign-in's new account) replaces it.
    if (client !== undefined) endSession();
    client = candidate;
    takeProfile(login);
    await refresh(candidate, login.user.username);
    return { ok: true, value: undefined };
  };

  /**
   * The desktop's provider sign-in (ADR-0044 §5): PKCE S256 and a state of
   * its own, the system browser via main's loopback listener, then the
   * one-time code traded for a bearer session.
   */
  const loopbackSignIn = async (provider: string, serverOrigin: string | undefined): Promise<AccountResult<void>> => {
    const oauthSignIn = deps.bridge?.oauthSignIn;
    if (oauthSignIn === undefined) return fail("unsupported");
    // The browser may take minutes; whatever signs in meanwhile wins.
    const started = ++attempt;
    const before = client;
    const built = anonymous(serverOrigin);
    if (!built.ok) return built;
    const random = (bytes: number): string => toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
    const verifier = random(32);
    const state = random(16);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    const answer = await oauthSignIn({
      serverOrigin: built.value.origin,
      provider,
      codeChallenge: toBase64Url(new Uint8Array(digest)),
      state,
    }).catch(() => ({ error: "loopback_failed" }));
    if ("error" in answer) return fail(answer.error);
    if (superseded(started, before)) return fail("superseded");
    return signIn(built.value.origin, (candidate) => candidate.exchangeOAuthCode(answer.code, verifier, deps.device?.()), started);
  };

  /**
   * The desktop's link from settings (#631): main's listener first, since
   * the server needs its redirect; then the one-time start URL the server
   * answered, opened in the system browser, which comes back with a code
   * this renderer trades with its verifier.
   */
  const loopbackLink = async (
    active: AccountClient,
    provider: string,
    confirmation: AccountConfirmation,
    stillLive: () => boolean,
  ): Promise<AccountResult<{ readonly redirect?: string }>> => {
    const oauthLink = deps.bridge?.oauthLink;
    if (oauthLink === undefined) return fail("unsupported");
    const random = (bytes: number): string => toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
    const state = random(16);
    // Only this renderer can finish the link: the code comes back to it, the verifier never left.
    const verifier = random(32);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    const listened = await oauthLink.listen({ serverOrigin: active.origin, state }).catch(() => ({ error: "loopback_failed" }));
    if ("error" in listened) return fail(listened.error);
    const begun = await active.linkProvider(provider, confirmation, {
      redirectUri: listened.redirectUri,
      codeChallenge: toBase64Url(new Uint8Array(digest)),
      state,
    });
    if (!begun.ok) return begun;
    const answer = await oauthLink.open({ state, url: begun.value }).catch(() => ({ error: "loopback_failed" }));
    if ("error" in answer) return fail(answer.error);
    // The browser may take minutes: a session that ended meanwhile doesn't get it.
    if (!stillLive()) return fail("session_ended");
    const done = await active.completeLink(answer.code, verifier);
    return done.ok ? { ok: true, value: {} } : done;
  };

  /** A pending sign-in finished: signed in here, or a native app's redirect to follow. */
  const pendingOutcome = async (
    result: AccountResult<PendingOutcome>,
    candidate: AccountClient,
  ): Promise<AccountResult<{ redirect?: string }>> => {
    if (!result.ok) return result;
    if (result.value.kind === "redirect") return { ok: true, value: { redirect: result.value.url } };
    const adopted = await adopt(candidate, result.value.session);
    return adopted.ok ? { ok: true, value: {} } : adopted;
  };

  /**
   * An account call that signs out when the server says the session is gone.
   * `onSuccess` runs only while the session that made the call is current.
   */
  const authed = async <T,>(
    call: (active: AccountClient) => Promise<AccountResult<T>>,
    onSuccess?: (value: T) => void,
  ): Promise<AccountResult<T>> => {
    if (client === undefined) return fail("unauthenticated");
    const active = client;
    const started = epoch;
    const result = await call(active);
    // Signed out (and maybe into another account) while this ran: the answer
    // belongs to the old session and must not touch the new one.
    if (!live(active, started)) return result;
    if (result.ok) onSuccess?.(result.value);
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

    providerFlow,
    authMethods: (serverOrigin) => beforeSession(serverOrigin, (candidate) => candidate.authMethods()),
    requestSignupCode: ({ email, serverOrigin }) => beforeSession(serverOrigin, (candidate) => candidate.requestSignupCode(email)),
    register: ({ email, code, password, serverOrigin }) =>
      signIn(serverOrigin, (candidate) => candidate.register({ email, code, password, device: deps.device?.() })),
    requestPasswordReset: ({ email, serverOrigin }) =>
      beforeSession(serverOrigin, (candidate) => candidate.requestPasswordReset(email)),
    resetPassword: ({ email, code, password, serverOrigin }) =>
      beforeSession(serverOrigin, (candidate) => candidate.resetPassword({ email, code, password })),
    providerSignIn: async ({ provider, serverOrigin }) => {
      if (providerFlow === "loopback") return loopbackSignIn(provider, serverOrigin);
      if (providerFlow === undefined) return fail("unsupported");
      (deps.navigate ?? ((url) => window.location.assign(url)))(
        `${normalizeServerOrigin(deps.origin)}/api/oauth/${encodeURIComponent(provider)}/start?client=web`,
      );
      // The page is leaving; nothing to settle on.
      return new Promise<never>(() => {});
    },
    requestEmailCode: (input) => authed((active) => active.requestEmailCode(input)),
    setEmail: async (input) => {
      // Only while the session that asked is still the one signed in.
      const result = await authed(
        (active) => active.setEmail(input),
        (value) => {
          takeProfile(value);
          if (state.status !== "signed-in") return;
          const { needsEmail: _held, ...rest } = state;
          setState({ ...rest, user: value.user.username, ...profile });
        },
      );
      return result.ok ? { ok: true, value: undefined } : result;
    },
    identities: () => authed((active) => active.identities()),
    requestReauthCode: () => authed((active) => active.requestReauthCode()),
    reauth: (proof) => authed((active) => active.reauth(proof)),
    linkProvider: async (provider, confirmation) => {
      if (providerFlow === "loopback") {
        return authed(async (active) => {
          const started = epoch;
          const stillLive = (): boolean => live(active, started);
          const result = await loopbackLink(active, provider, confirmation, stillLive);
          // Nor is a link reported to whoever signed in while it finished.
          return result.ok && !stillLive() ? fail("session_ended") : result;
        });
      }
      const result = await authed((active) => active.linkProvider(provider, confirmation));
      return result.ok ? { ok: true, value: { redirect: result.value } } : result;
    },
    unlinkProvider: (provider, confirmation) => authed((active) => active.unlinkProvider(provider, confirmation)),
    pendingSignIn: (id) => beforeSession(undefined, (candidate) => candidate.pendingSignIn(id)),
    createFromPending: async (id, options) => {
      // A sign-in like any other: an older one still waiting must not land after it.
      attempt += 1;
      if (mode === "cookie") await pendingLogout;
      const built = anonymous(undefined);
      if (!built.ok) return built;
      return pendingOutcome(
        await built.value.createFromPending(id, {
          ...(options?.password === undefined ? {} : { password: options.password }),
          device: deps.device?.(),
        }),
        built.value,
      );
    },
    linkPending: async (id, confirmation) => {
      const result = await authed((active) => active.linkPending(id, confirmation));
      if (!result.ok) return result;
      return { ok: true, value: result.value === undefined ? {} : { redirect: result.value } };
    },
    signInAndLinkPending: async (id, { username, password }) => {
      const signedIn = await signIn(undefined, (candidate) => candidate.login(username, password, deps.device?.()));
      if (!signedIn.ok) return signedIn;
      const result = await authed((active) => active.linkPending(id, password));
      if (!result.ok) return result;
      return { ok: true, value: result.value === undefined ? {} : { redirect: result.value } };
    },

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

    changePassword: ({ confirmation, newPassword }) =>
      authed((active) => active.changePassword(confirmation, newPassword)),
    // Unlike revokeAll, a failure keeps the session: the account may still exist.
    deleteAccount: ({ confirmation }) =>
      authed(
        (active) => active.deleteAccount(confirmation),
        () => {
          if (mode === "bearer") void deps.bridge?.account?.clear().catch(() => undefined);
          signedOut();
        },
      ),
    listDevices: () => authed((active) => active.listDevices()),
    kickDevice: ({ id, confirmation }) => authed((active) => active.kickDevice(id, confirmation)),
    removeHost,
    createJoinToken: () => authed((active) => active.createJoinToken()),
    lookupHostLink: (userCode) => authed((active) => active.lookupHostLink(userCode)),
    confirmHostLink: (userCode) => authed((active) => active.confirmHostLink(userCode)),
    denyHostLink: (userCode) => authed((active) => active.denyHostLink(userCode)),
    lookupHostLinkRequest: (requestId) => authed((active) => active.lookupHostLinkRequest(requestId)),
    confirmHostLinkRequest: (requestId) => authed((active) => active.confirmHostLinkRequest(requestId)),
    denyHostLinkRequest: (requestId) => authed((active) => active.denyHostLinkRequest(requestId)),
    watchForHost,

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
