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

/** How this client authenticates to the account API (ADR-0022 §2). */
export type AccountMode = "cookie" | "bearer";

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
       * A host the account pairing registered but whose save failed — the
       * device key dies with the page if it isn't persisted, so it stays
       * here for `retryUnsavedHost`.
       */
      readonly unsavedHost?: StoredHost;
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
   * IK pairing → persisted with its account link. Never invoked by the model
   * itself — a rejected stored host is reported via hostRejected, not repaired.
   */
  pairHost(hostId: string): Promise<AccountResult<StoredHost>>;
  /** Retry persisting `state.unsavedHost` after a failed save. */
  retryUnsavedHost(): Promise<AccountResult<void>>;
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
}

const fail = (code: string): AccountResult<never> => ({ ok: false, error: { code } });

export function createAccountModel(deps: AccountModelDeps): AccountModel {
  const listeners = new Set<() => void>();
  let state: AccountState = { status: "checking" };
  // The live client exists iff state is signed-in (or a login is in flight).
  let client: AccountClient | undefined;
  let mode: AccountMode = deps.bridge === undefined ? "cookie" : "bearer";
  let lastOrigin: string | undefined;
  const rejected = new Set<string>();

  const setState = (next: AccountState): void => {
    state = next;
    for (const listener of listeners) listener();
  };

  const signedOut = (): void => {
    client = undefined;
    setState({
      status: "signed-out",
      mode,
      ...(lastOrigin === undefined ? {} : { serverOrigin: lastOrigin }),
    });
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
      setState({
        status: "signed-in",
        mode,
        user,
        serverOrigin: active.origin,
        hosts: previous,
        hostsError: rows.error,
        rejectedHostKeys: [...rejected],
      });
      return rows;
    }
    const stored = await deps.hosts.list().catch(() => [] as readonly StoredHost[]);
    if (client !== active) return { ok: false, error: { code: "stale" } };
    const matches = matchAccountHosts(active.origin, rows.value, stored);
    // Adopt pre-account pairings: same Noise key, no link yet — bookkeeping,
    // not a re-pair, so a failed save is unremarkable.
    for (const match of matches) {
      if (match.linkable && match.stored !== undefined) {
        const host = match.stored;
        void deps.hosts
          .save({ ...host, account: { serverOrigin: active.origin, hostId: match.host.hostId } })
          .catch(() => undefined);
      }
    }
    setState({
      status: "signed-in",
      mode,
      user,
      serverOrigin: active.origin,
      hosts: matches,
      rejectedHostKeys: [...rejected],
    });
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

    pairHost: async (hostId) => {
      if (client === undefined) return fail("unauthenticated");
      const name = deps.name ?? (() => "This device");
      const result = await pairViaAccount(client, hostId, await name(), deps.connect);
      if (!result.ok) {
        if (isUnauthenticated(result.error)) signedOut();
        return result;
      }
      // The account row already knows the machine's name — the stored entry
      // carries it so labels need not wait for the settings stream (5.12).
      const announced = state.status === "signed-in"
        ? state.hosts.find((match) => match.host.hostId === hostId)?.host.name
        : undefined;
      const enriched: StoredHost =
        announced === undefined || announced === "" ? result.value : { ...result.value, name: announced };
      rejected.delete(enriched.hostKey);
      try {
        await deps.paired(enriched);
      } catch {
        // The invite is spent and the device registered — a failed save must
        // not orphan the key. Keep the record for retryUnsavedHost.
        if (state.status === "signed-in") setState({ ...state, unsavedHost: enriched });
        return { ok: false, error: { code: "pairing_not_saved" } };
      }
      // A re-pair after a key change stored a fresh record under the new key;
      // the stale linked record can never connect again — drop it so it stops
      // matching this account host.
      const stored = await deps.hosts.list().catch(() => [] as readonly StoredHost[]);
      for (const entry of stored) {
        if (
          entry.account !== undefined &&
          normalizeServerOrigin(entry.account.serverOrigin) === client.origin &&
          entry.account.hostId === hostId &&
          entry.hostKey !== enriched.hostKey
        ) {
          void deps.hosts.remove(entry.hostKey).catch(() => undefined);
        }
      }
      if (state.status === "signed-in" && client !== undefined) await refresh(client, state.user);
      return { ok: true, value: enriched };
    },

    retryUnsavedHost: async () => {
      const pending = state.status === "signed-in" ? state.unsavedHost : undefined;
      if (pending === undefined) return fail("nothing_pending");
      try {
        await deps.paired(pending);
      } catch {
        return fail("pairing_not_saved");
      }
      if (state.status === "signed-in") setState({ ...state, unsavedHost: undefined });
      return { ok: true, value: undefined };
    },

    hostRejected: (hostKey) => {
      rejected.add(hostKey);
      if (state.status === "signed-in") setState({ ...state, rejectedHostKeys: [...rejected] });
    },
  };
}

/**
 * The app's account model, bound to the shared host store: `paired` both
 * persists and marks the host active so a fresh pairing connects next load.
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
