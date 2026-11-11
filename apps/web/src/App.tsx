import { Button } from "./shared/ui/button.tsx";
import { ChatLayout } from "@astryxdesign/core/Chat";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/shared/ui/dialog";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { Field, FieldLabel } from "./shared/ui/field.tsx";
import { Input } from "./shared/ui/input.tsx";
import type { ConversationId } from "@earendil-works/pi-durable";
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { outgoingImage, type ImageVariant } from "@pinomad/protocol/images.ts";
import { findConversation, type ConversationNode, type Home } from "@pinomad/protocol/organization.ts";
import { currentAgentOf } from "./entities/conversation/current-agent.ts";
import { canStopSubagent, conversationName } from "./entities/conversation/subagent.ts";
import { forksAt, rootOf, taskGroupsOf } from "@pinomad/client/family.ts";
import { hostLabels, mergeStoredHost, updateStoredHostConnection, updateStoredHostEndpoints } from "@pinomad/client/stored-host.ts";
import { candidatePlan, preferredLegacyUrl } from "@pinomad/protocol/remote-candidates.ts";
import { requestNotificationPermission } from "./entities/conversation/notification-permission.ts";
import { ImageSourceProvider, useImageRetryKey } from "./entities/image/image-source.tsx";
import { useRunNotifications } from "./entities/conversation/use-run-notifications.ts";
import { useConversationOpening, type Opening } from "./entities/conversation/use-conversation-opening.ts";
import { AppFrame, FrameHeader } from "./widgets/app-frame/app-frame.tsx";
import { HostFrame } from "./widgets/app-frame/host-frame.tsx";
import { DraftHome } from "./widgets/draft-home/draft-home.tsx";
import { ConversationComposer } from "./widgets/composer/conversation-composer.tsx";
import { takeBackForConversation, type PendingTakeBack } from "./widgets/composer/take-back.ts";
import { ConversationTranscript } from "./widgets/chat/conversation-transcript.tsx";
import { ComposerSkeleton, ConversationSkeleton, ConversationUnavailable } from "./widgets/chat/conversation-skeleton.tsx";
import { panelSurfaceOf, SidePanel, SurfaceButtons, type PanelSurface } from "./widgets/side-panel/side-panel.tsx";
import { OverviewCard } from "./widgets/overview/overview-card.tsx";
import { PendingQuestions } from "./presentation/question.tsx";
import type { RemoteDurable, RemoteDurableOptions } from "@pinomad/protocol/remote-durable.ts";
import { isBusy } from "@pinomad/protocol/transcript.ts";
import { isProcessActive } from "@pinomad/protocol/processes.ts";
import { useProcessList } from "./entities/process/use-process-list.ts";
import type { DurableView } from "@pinomad/protocol/view.ts";
import { generateKeyPair, keyPairFromPrivate, type KeyPair } from "@pinomad/protocol/noise.ts";
import { fromBase64Url, toBase64Url } from "@pinomad/protocol/secure-channel.ts";
import { clientDeviceName, resolveAddress, type ResolvedAddress, type StoredHost } from "./address.ts";
import { HostsContext, hostStore, useHostNameSync, useHosts, type HostsState } from "./entities/host/host-store.ts";
import {
  focusPairedHost,
  readFocus,
  rememberedHostFocus,
  seedRememberedFocus,
  writeFocus,
  type ConversationRef,
  type HostFocus,
} from "./entities/host/focus.ts";
import { browserDeclined, cancelAccountRegistration } from "./entities/account/declined.ts";
import { writeLastNewHost } from "./entities/host/last-new-host.ts";
import {
  createHostRuntimeRegistry,
  HostRuntimesContext,
} from "./entities/host/host-runtimes.ts";
import { useComposerSlot, useComposerSlotState } from "./entities/composer/composer-context.tsx";
import { HostsFallback } from "./widgets/app-frame/hosts.tsx";
import { AccountProvider, useAccountModel } from "./entities/account/account-context.tsx";
import { PairingLinkForm } from "./entities/host/pairing-link-form.tsx";
import { DeviceRejected } from "./widgets/app-frame/device-rejected.tsx";
import { NoHostLink } from "./widgets/account/no-host-link.tsx";
import { HostLinkRoute } from "./widgets/account/host-link-route.tsx";
import { AddEmailGate } from "./widgets/account/add-email-gate.tsx";
import { OAuthReturnDialog } from "./widgets/account/account-dialog.tsx";
import { PendingSignInRoute } from "./widgets/account/pending-sign-in.tsx";
import { NewHostNotices } from "./widgets/account/new-host-notice.tsx";
import { useDurableView, useRemoteDurable } from "./use-remote.ts";
import { createBrowserRtcPlatform } from "./entities/host/browser-rtc.ts";
import { secureOptions } from "./entities/host/secure-options.ts";
import { HostRuntimes, type RemoteConnect } from "./entities/host/host-runtime.tsx";
import { syncAppHint } from "./shared/app-hint.ts";
import { Centered } from "./shared/ui/centered.tsx";
import { reloadedKey, VersionMismatch } from "./widgets/app-frame/version-mismatch.tsx";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "./shared/ui/alert.tsx";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "./shared/ui/empty.tsx";
import { Toaster, useToast } from "./shared/ui/toast.tsx";

const chatColumn: CSSProperties = { flex: 1, minHeight: 0 };

const anyAtWork = (nodes: readonly ConversationNode[]): boolean =>
  nodes.some(
    (node) =>
      node.summary.status === "running"
      || node.summary.status === "needs-answer"
      || anyAtWork(node.children),
  );

const OVERVIEW_OPEN_KEY = "pinomad.overview.open";
const readOverviewOpen = (): boolean =>
  typeof window !== "undefined" && window.localStorage.getItem(OVERVIEW_OPEN_KEY) === "true";
const PANEL_SURFACE_KEY = "pinomad.side-panel.surface";
const readPanelSurface = (): PanelSurface =>
  panelSurfaceOf(typeof window === "undefined" ? null : window.localStorage.getItem(PANEL_SURFACE_KEY));

type Loaded = {
  readonly hosts: readonly StoredHost[];
  readonly focus: HostFocus | null;
  readonly address: ResolvedAddress | undefined;
};

/** One fork creation per Workbench; its invisible side is the handoff to main. */
type ForkOperation = {
  readonly parentId: ConversationId;
  readonly entryId: string;
  /** The side already open before the fork call; anything else is a candidate. */
  readonly sideBeforeId: ConversationId | undefined;
  /** The staged side once its snapshot or summary identifies our fork. */
  stagedId: ConversationId | undefined;
  /** The summary matched; main was opened and the staged side is retired. */
  confirmed: boolean;
  /** The side was replaced or disappeared, or it is not our fork. */
  cancelled: boolean;
  /** The fork controller call, including its first submit, has settled. */
  commandSettled: boolean;
};

export function App() {
  const [store] = useState(hostStore);
  const registry = useMemo(createHostRuntimeRegistry, []);
  // Conversation each host last showed, for the sidebar's "focus this host"
  // action and for restoring the focus after a forget.
  const lastByHost = useRef(new Map<string, ConversationId>());
  // A pairing can finish before the initial list read; remember it and merge
  // it into the first snapshot instead of dropping its runtime.
  const pendingPairings = useRef(new Map<string, StoredHost>());
  // Hosts a forget has taken off screen but not yet out of the store: a save
  // already in flight (an account link adopted, say) must not put them back.
  const forgetting = useRef(new Set<string>());
  const [loaded, setLoaded] = useState<Loaded>();
  useEffect(() => {
    let live = true;
    void store
      .list()
      .catch((error: unknown) => {
        console.error("Could not load the paired-host list", error);
        return [] as readonly StoredHost[];
      })
      .then((hosts) => {
        if (!live) return;
        let merged = [...hosts];
        for (const pending of pendingPairings.current.values()) {
          const existing = merged.find((each) => each.hostKey === pending.hostKey);
          merged = [
            ...merged.filter((each) => each.hostKey !== pending.hostKey),
            existing === undefined ? pending : mergeStoredHost(existing, pending),
          ];
        }
        pendingPairings.current.clear();
        const focus = readFocus(localStorage, merged) ?? null;
        seedRememberedFocus(lastByHost.current, focus);
        setLoaded({
          hosts: merged,
          focus,
          // Only a live fragment (#token=…, #pair=…) resolves to a one-shot
          // screen. Stored hosts all run at once; their focus is separate.
          address: resolveAddress(window.location.hash, window.location, merged, focus?.hostKey ?? null),
        });
      });
    return () => {
      live = false;
    };
  }, [store]);
  // A same-document hash hop (a pinomad:// deep link into an open window, a
  // pasted hash edit) changes no React state — reload to re-resolve the
  // address. onPaired's replaceState fires no hashchange, so this can't loop.
  useEffect(() => {
    const onHashChange = (): void => {
      if (window.location.hash !== "") window.location.reload();
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const rememberedFocus = useCallback(
    (hostKey: string): HostFocus => rememberedHostFocus(lastByHost.current, hostKey),
    [],
  );

  const focusHost = useCallback(
    (hostKey: string): void => {
      // A one-shot token/pair screen must yield to the stored host the user
      // picked — including the address bar, or a refresh returns to it.
      history.replaceState(null, "", window.location.pathname + window.location.search);
      setLoaded((prev) =>
        prev === undefined
          ? prev
          : {
              ...prev,
              address: undefined,
              focus: rememberedFocus(hostKey),
            },
      );
    },
    [rememberedFocus],
  );

  const focusConversation = useCallback((ref: ConversationRef): void => {
    setLoaded((prev) => {
      // A notification outlives the runtime it came from; clicking it after a
      // forget must not leave the app focused on a host that no longer exists.
      if (prev === undefined || !prev.hosts.some((host) => host.hostKey === ref.hostKey)) return prev;
      lastByHost.current.set(ref.hostKey, ref.conversationId);
      return { ...prev, focus: { ...ref } };
    });
  }, []);

  const rememberConversation = useCallback((ref: ConversationRef): void => {
    setLoaded((prev) => {
      if (prev === undefined || !prev.hosts.some((host) => host.hostKey === ref.hostKey)) return prev;
      // A background create lands in that host's remembered slot without
      // stealing focus from wherever the user moved.
      lastByHost.current.set(ref.hostKey, ref.conversationId);
      return prev;
    });
  }, []);

  const focusDraft = useCallback((hostKey: string): void => {
    lastByHost.current.delete(hostKey);
    setLoaded((prev) => (prev === undefined ? prev : { ...prev, focus: { hostKey } }));
  }, []);

  /** Take a host off screen; its stored record is the caller's to remove. */
  const dropFromView = useCallback(
    (hostKey: string, clearAddress: boolean): void => {
      lastByHost.current.delete(hostKey);
      if (clearAddress) {
        // A live #token=…/#pair=… fragment outlives the stored list; drop it so
        // the emptied list can land on the no-link screen instead of reconnecting.
        history.replaceState(null, "", window.location.pathname + window.location.search);
      }
      setLoaded((prev) => {
        if (prev === undefined) return prev;
        const hosts = prev.hosts.filter((each) => each.hostKey !== hostKey);
        const address = clearAddress ? undefined : prev.address;
        if (prev.focus?.hostKey !== hostKey) return { ...prev, hosts, address };
        return {
          ...prev,
          hosts,
          address,
          focus: hosts[0] === undefined ? null : rememberedFocus(hosts[0].hostKey),
        };
      });
    },
    [rememberedFocus],
  );

  const removeStored = useCallback(
    (hostKey: string): Promise<void> =>
      store.remove(hostKey).catch((error: unknown) => {
        console.error("Could not remove the host", error);
      }),
    [store],
  );

  /** Remove a superseded identity without treating it as a user forget. */
  const dropHost = useCallback(
    async (hostKey: string): Promise<void> => {
      await removeStored(hostKey);
      dropFromView(hostKey, false);
    },
    [dropFromView, removeStored],
  );

  const forget = useCallback(
    async (hostKey: string): Promise<void> => {
      // Account adoption can link this host in the store without touching the
      // loaded snapshot (or another tab may have done it), so read the latest
      // record before deciding whether forgetting should decline it.
      const latest = store.list().catch(() => loaded?.hosts ?? []);
      // Off screen before any await: a host that just unpaired this device
      // closes it at once, and its refusal must not flash up meanwhile.
      forgetting.current.add(hostKey);
      dropFromView(hostKey, true);
      try {
        const persisted = await latest;
        const host = persisted.find((each) => each.hostKey === hostKey)
          ?? loaded?.hosts.find((each) => each.hostKey === hostKey);
        if (host?.account !== undefined) {
          // A forgotten account host is declined so the next account refresh
          // cannot silently register it again (ADR-0035 §5).
          browserDeclined.add(host.account);
          cancelAccountRegistration(host.account.hostId);
        }
        await removeStored(hostKey);
      } finally {
        forgetting.current.delete(hostKey);
      }
    },
    [dropFromView, loaded?.hosts, removeStored, store],
  );

  const paired = useCallback(
    async (host: StoredHost): Promise<void> => {
      if (forgetting.current.has(host.hostKey)) return;
      await store.save(host);
      // The save may have outlived a forget that started meanwhile; that
      // forget removes the record, and the host stays off screen.
      if (forgetting.current.has(host.hostKey)) return;
      setLoaded((prev) => {
        if (prev === undefined) {
          const pending = pendingPairings.current.get(host.hostKey);
          pendingPairings.current.set(host.hostKey, pending === undefined ? host : mergeStoredHost(pending, host));
          return prev;
        }
        const existing = prev.hosts.find((each) => each.hostKey === host.hostKey);
        return {
          ...prev,
          // A first host (auto-registered into an empty device) still needs a
          // focus to paint; an existing focus is never moved by registration.
          focus: prev.focus ?? { hostKey: host.hostKey },
          hosts: [
            ...prev.hosts.filter((each) => each.hostKey !== host.hostKey),
            existing === undefined ? host : mergeStoredHost(existing, host),
          ],
        };
      });
    },
    [store],
  );

  const setName = useCallback(
    async (hostKey: string, name: string): Promise<void> => {
      await store.setName(hostKey, name);
      setLoaded((prev) =>
        prev === undefined
          ? prev
          : {
              ...prev,
              hosts: prev.hosts.map((each) => (each.hostKey === hostKey ? { ...each, name } : each)),
            },
      );
    },
    [store],
  );

  const endpoints = useCallback(
    async (hostKey: string, endpointSet: Parameters<HostsState["endpoints"]>[1]): Promise<void> => {
      await store.updateEndpoints(hostKey, endpointSet);
      setLoaded((prev) =>
        prev === undefined
          ? prev
          : {
              ...prev,
              hosts: prev.hosts.map((each) =>
                each.hostKey === hostKey ? updateStoredHostEndpoints(each, endpointSet) : each,
              ),
            },
      );
    },
    [store],
  );

  const setConnection = useCallback(
    async (hostKey: string, change: Parameters<HostsState["setConnection"]>[1]): Promise<void> => {
      await store.updateConnection(hostKey, change);
      setLoaded((prev) =>
        prev === undefined
          ? prev
          : {
              ...prev,
              hosts: prev.hosts.map((each) =>
                each.hostKey === hostKey ? updateStoredHostConnection(each, change) : each,
              ),
            },
      );
    },
    [store],
  );

  const state = useMemo<HostsState>(
    () =>
      loaded === undefined
        ? {
            store,
            hosts: [],
            focus: null,
            paired: () => Promise.resolve(),
            setName: () => Promise.resolve(),
            endpoints: () => Promise.resolve(),
            setConnection: () => Promise.resolve(),
            focusHost: () => {},
            focusConversation: () => {},
            rememberConversation: () => {},
            focusDraft: () => {},
            forget: () => Promise.resolve(),
            dropHost: () => Promise.resolve(),
          }
        : {
            store,
            hosts: loaded.hosts,
            focus: loaded.focus,
            paired,
            setName,
            endpoints,
            setConnection,
            focusHost,
            focusConversation,
            rememberConversation,
            focusDraft,
            forget,
            dropHost,
          },
    [dropHost, endpoints, focusConversation, focusDraft, focusHost, forget, loaded, paired, rememberConversation, setConnection, setName, store],
  );

  useEffect(() => {
    if (loaded === undefined) return;
    writeFocus(localStorage, loaded.focus ?? undefined);
  }, [loaded?.focus]);

  if (loaded === undefined) return <Centered>{null}</Centered>;
  const { address, focus, hosts } = loaded;
  const pairedHost = (host: StoredHost): void => {
    history.replaceState(null, "", window.location.pathname + window.location.search);
    setLoaded((prev) =>
      prev === undefined
        ? prev
        : {
            ...prev,
            address: undefined,
            focus: focusPairedHost(lastByHost.current, prev.focus, host.hostKey),
          },
    );
  };
  return (
    <HostsContext.Provider value={state}>
      <HostRuntimesContext.Provider value={registry}>
        <AccountProvider>
          {/* Every screen's toasts, the one-shot token workbench and the
              connection-failure screens included; AppFrame's own Toaster
              defers to this one. */}
          <Toaster className="top-12">
            <AppHint hostCount={hosts.length} />
            <AddEmailGate>
              {address?.kind === "token" ? (
                <RemoteWorkbench
                  options={address}
                  connectionKey={`${address.url} ${address.token}`}
                  label={address.url}
                />
              ) : address?.kind === "pair" ? (
                <PairConfirm address={address} onPairedHost={pairedHost} />
              ) : hosts.length === 0 ? (
                <Centered>
                  <NoHostLink />
                </Centered>
              ) : (
                <HostFrame>
                  <HostRuntimes
                    hosts={hosts}
                    focus={focus}
                    renderWorkbench={({
                      host,
                      remote,
                      device,
                      rejected,
                      retry,
                      opening,
                      cancelOpening,
                      openConversation,
                    }) => (
                      <Workbench
                        remote={remote}
                        wsUrl={host.url}
                        rejected={rejected}
                        device={device}
                        hostKey={host.hostKey}
                        onReconnect={retry}
                        notify={false}
                        framed={false}
                        hostOpening={opening}
                        hostOpen={openConversation}
                        hostCancelOpening={cancelOpening}
                      />
                    )}
                  />
                </HostFrame>
              )}
            </AddEmailGate>
            {/* Above whichever screen is showing, so a first host pairing (which swaps
                the no-host screen for the workbench) doesn't close or lose them. */}
            <HostLinkRoute />
            <PendingSignInRoute />
            {/* The no-host screen has the panel already; a one-shot token or pair screen is left alone. */}
            <OAuthReturnDialog stayClosed={address !== undefined || hosts.length === 0} />
            <NewHostNotices />
          </Toaster>
        </AccountProvider>
      </HostRuntimesContext.Provider>
    </HostsContext.Provider>
  );
}

/**
 * The "this browser uses the web app" marker read by pinomad.si (#354).
 * Signed in counts, and so does any paired host — a QR-only pairing has no
 * account. Signing out with no hosts left clears it. syncAppHint writes only
 * on the official app host, so self-hosted copies and the desktop app no-op.
 */
function AppHint({ hostCount }: { hostCount: number }) {
  const { state } = useAccountModel();
  const inUse =
    state.status === "signed-in" || hostCount > 0
      ? true
      : state.status === "signed-out"
        ? false
        : undefined;
  useEffect(() => {
    if (inUse === undefined) return;
    syncAppHint(window.location.hostname, inUse);
  }, [inUse]);
  return null;
}

/**
 * A pair link opens a socket only after the user has seen which host it is:
 * pairing with an attacker-controlled host would register this device — for
 * every pair link, browser QR or pasted, one uniform rule.
 */
function PairConfirm({
  address,
  onPairedHost,
}: {
  address: Extract<ResolvedAddress, { kind: "pair" }>;
  onPairedHost?: (host: StoredHost) => void;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const cancel = (): void => {
    history.replaceState(null, "", window.location.pathname + window.location.search);
    window.location.reload();
  };
  if (confirmed) return <SecureClient address={address} {...(onPairedHost === undefined ? {} : { onPairedHost })} />;
  const target = new URL(address.url);
  return (
    <Centered>
      <div className="flex flex-col items-center gap-4" style={{ maxWidth: 420 }}>
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Pair with this host?</EmptyTitle>
            <EmptyDescription>{`This device will pair with ${target.host}.`}</EmptyDescription>
          </EmptyHeader>
        </Empty>
        <span className="text-xs/5 text-muted-foreground" style={{ wordBreak: "break-all" }}>
          {address.url}
        </span>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={cancel}>Cancel</Button>
          <Button variant="primary" onClick={() => setConfirmed(true)}>Pair</Button>
        </div>
      </div>
    </Centered>
  );
}

/** A secure-channel client: pairing on first sight of the QR link, stored key after. */
export function SecureClient({
  address,
  connect,
  onPairedHost,
}: {
  address: Extract<ResolvedAddress, { kind: "pair" | "device" }>;
  /** Test seam, matching useRemoteDurable's connect override. */
  connect?: RemoteConnect;
  /** A pair that reached message 2 and saved: the app can replace the one-shot flow with its runtime. */
  onPairedHost?: (host: StoredHost) => void;
}) {
  const { hosts, paired, endpoints, setConnection } = useHosts();
  const stored = useMemo(() => hosts.find((host) => host.hostKey === address.hostKey), [hosts, address]);
  // A pairing whose save failed (e.g. locked keychain): the device key would
  // die with the process, and the spent invite can't pair again — surface it
  // instead of losing the identity silently.
  const [unsaved, setUnsaved] = useState<StoredHost>();
  // Manual retries must keep the identity and stop replaying the invite secret
  // once message 2 verified, even if the save or first sync failed afterwards.
  const pairedRef = useRef(false);
  const [pairedOnce, setPairedOnce] = useState(false);
  const device = useMemo<KeyPair>(() => {
    // A stored key for the same host survives a spent pairing link: the host
    // admits a registered device without consuming the offer.
    if (address.kind === "pair" && stored !== undefined) {
      return keyPairFromPrivate(fromBase64Url(stored.privateKey));
    }
    return address.kind === "device" ? keyPairFromPrivate(fromBase64Url(address.privateKey)) : generateKeyPair();
  }, [address, stored]);
  // The pairing label can come from the desktop bridge — an async hop — so it
  // resolves before the transport exists; the PairConfirm gate means it is
  // almost always settled by the time this runs.
  const [pairName, setPairName] = useState<string>();
  useEffect(() => {
    if (address.kind !== "pair") return;
    let live = true;
    void clientDeviceName().then((name) => {
      if (live) setPairName(name);
    });
    return () => {
      live = false;
    };
  }, [address]);
  // Retry reads the latest stored address set, not the one this page started
  // with; the connection key below deliberately excludes it, so a background
  // hello update does not restart a healthy connection.
  const target = useMemo(
    () => ({
      url: stored?.url ?? address.url,
      endpointSet: stored?.endpointSet ?? address.endpointSet,
    }),
    [address, stored],
  );
  const candidates = useMemo(
    () => candidatePlan(target.url, target.endpointSet, { pageProtocol: window.location.protocol }),
    [target],
  );
  const pairing =
    address.kind === "pair" && !pairedOnce && pairName !== undefined
      ? { secret: address.secret, name: pairName }
      : undefined;
  // The renderer owns the browser half of RTC; a window without WebRTC (an
  // old Electron shell, a test DOM) omits the option entirely and the
  // coordinator behaves exactly as before.
  const rtcPlatform = useMemo(() => createBrowserRtcPlatform(), []);
  const options = useMemo<RemoteDurableOptions | undefined>(() => {
    // A pair address holds off opening the socket until the label resolves —
    // the name travels inside the first handshake.
    if (address.kind === "pair" && pairName === undefined) return undefined;
    return secureOptions({
      hostKey: address.hostKey,
      device,
      target,
      candidates,
      stored,
      rtcPlatform,
      ...(pairing === undefined ? {} : { pairing }),
      setConnection,
      onPaired: () => {
        if (pairedRef.current) return;
        pairedRef.current = true;
        setPairedOnce(true);
        const endpointSet = address.endpointSet;
        const host: StoredHost = {
          url: endpointSet === undefined ? address.url : preferredLegacyUrl(address.url, endpointSet),
          hostKey: address.hostKey,
          privateKey: toBase64Url(device.privateKey),
          ...(endpointSet === undefined ? {} : { endpointSet }),
        };
        const saved = stored === undefined ? host : mergeStoredHost(stored, host);
        void paired(saved).then(
          () => onPairedHost?.(saved),
          (error: unknown) => {
            console.error("Could not save the paired host", error);
            setUnsaved(saved);
          },
        );
        // The fragment held a one-time secret; it must not linger in history.
        history.replaceState(null, "", window.location.pathname + window.location.search);
      },
      // A validated hello set, including an explicit empty one, is an
      // address-only update keyed by hostKey; identity and account stay put.
      onEndpointSet: (endpointSet) => {
        void endpoints(address.hostKey, endpointSet).catch((error: unknown) =>
          console.error("Could not store the host's remote endpoints", error),
        );
      },
    });
  }, [address, candidates, device, endpoints, onPairedHost, paired, pairName, pairing, rtcPlatform, setConnection, stored, target]);
  if (options === undefined) return <Centered>{null}</Centered>;
  const rejected =
    address.kind === "pair" ? (
      // A pairing offer is single-use; a rejected one is the offer's problem,
      // not this device's — never offer to wipe a saved pairing from here.
      <div className="flex flex-col items-center gap-4">
        <Empty>
          <EmptyHeader>
            <EmptyTitle>This pairing code was used or has expired</EmptyTitle>
            <EmptyDescription>Generate a new QR on the host: run pinomad pair, or open Settings → Devices → Pair a device.</EmptyDescription>
          </EmptyHeader>
        </Empty>
        <div className="w-full max-w-md">
          <PairingLinkForm />
        </div>
        {hosts.length === 0 ? null : (
          <Button
            variant="secondary"
            onClick={() => {
              history.replaceState(null, "", window.location.pathname + window.location.search);
              window.location.reload();
            }}
          >
            Use saved pairing
          </Button>
        )}
      </div>
    ) : (
      <DeviceRejected hostKey={address.hostKey} />
    );
  const notice =
    unsaved === undefined ? undefined : (
      <Alert variant="warning" className="rounded-none">
        <AlertTitle>This pairing wasn't saved</AlertTitle>
        <AlertDescription>It will be lost when the app restarts.</AlertDescription>
        <AlertAction>
          <Button
            variant="secondary"
            onClick={() => {
              void paired(unsaved).then(
                () => {
                  setUnsaved(undefined);
                  onPairedHost?.(unsaved);
                },
                (error: unknown) => console.error("Could not save the paired host", error),
              );
            }}
          >
            Retry
          </Button>
        </AlertAction>
      </Alert>
    );
  return (
    <RemoteWorkbench
      options={options}
      // Stable across background address updates: only a manual Retry (its
      // attempt counter) or another host remounts the connection.
      connectionKey={address.hostKey}
      label={target.url}
      rejected={rejected}
      device={device}
      notice={notice}
      hostKey={address.hostKey}
      {...(connect === undefined ? {} : { connect })}
    />
  );
}

/** Connects with `options` and shows the workbench, or why it cannot. */
export function RemoteWorkbench({
  options,
  connectionKey,
  label,
  rejected,
  device,
  notice,
  hostKey,
  connect,
}: {
  options: RemoteDurableOptions;
  connectionKey: string;
  label: string;
  /** Secure-channel 4401: pairing failed or the device was revoked. */
  rejected?: ReactNode;
  /** This browser's device key, for marking "This device" in the devices list. */
  device?: KeyPair;
  /** A persistent warning shown above the connection banner. */
  notice?: ReactNode;
  /** The stored pairing this connection authenticates as — absent for token clients (5.12 name caching). */
  hostKey?: string;
  /** Test seam forwarded to useRemoteDurable. */
  connect?: RemoteConnect;
}) {
  // Bumping the attempt counter changes the connection key, which remounts the
  // connection — the same fresh connect a page reload would give, without
  // losing the resolved address.
  const [attempt, setAttempt] = useState(0);
  const state = useRemoteDurable(
    options,
    `${connectionKey} ${attempt}`,
    connect === undefined ? undefined : { connect },
  );
  if (state.status === "connecting") {
    return (
      <Centered>
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Connecting</EmptyTitle>
            <EmptyDescription>{label}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </Centered>
    );
  }
  if (state.status === "failed") {
    // Only a 4401 rejection means the pairing itself is bad — an unreachable
    // host keeps the key and the banner. These screens have no sidebar, so
    // the hosts list repeats inline — except under a rejection, whose screen
    // carries its own way forward.
    return (
      <Centered>
        {notice === undefined ? null : <div className="w-full max-w-md">{notice}</div>}
        {state.mismatch !== undefined ? (
          <VersionMismatch wsUrl={label} mismatch={state.mismatch} {...(hostKey === undefined ? {} : { hostKey })} />
        ) : rejected !== undefined && state.unauthorized ? (
          rejected
        ) : (
          <div className="flex flex-col items-center gap-4">
            <Alert variant="destructive">
              <AlertTitle>{state.direct === undefined ? "Could not connect to the host" : "Direct connection unavailable"}</AlertTitle>
              <AlertDescription>
                {state.direct === undefined
                  ? state.error
                  : "This host can't be reached without the relay, and the peer-to-peer link didn't connect."}
              </AlertDescription>
            </Alert>
            {state.direct === undefined ? null : (
              <span className="text-xs/5 text-muted-foreground" style={{ textAlign: "center" }}>
                {`Details: ${state.direct.reason}`}
              </span>
            )}
            {state.direct === undefined ? null : (
              <span className="text-xs/5 text-muted-foreground" style={{ textAlign: "center" }}>
                Change this host's connection mode under Hosts below, then retry.
              </span>
            )}
            <Button variant="secondary" onClick={() => setAttempt(attempt + 1)}>Retry</Button>
          </div>
        )}
        {rejected !== undefined && state.unauthorized ? null : <HostsFallback canSwitch />}
      </Centered>
    );
  }
  return (
    <Workbench
      remote={state.remote}
      wsUrl={label}
      rejected={rejected}
      device={device}
      notice={notice}
      hostKey={hostKey}
      onReconnect={() => setAttempt(attempt + 1)}
    />
  );
}

export function Workbench({
  remote,
  wsUrl,
  rejected,
  device,
  notice,
  hostKey,
  onReconnect,
  notify = true,
  framed = true,
  hostOpening,
  hostOpen,
  hostCancelOpening,
}: {
  remote: RemoteDurable;
  wsUrl: string;
  rejected?: ReactNode;
  device?: KeyPair;
  notice?: ReactNode;
  hostKey?: string;
  onReconnect?: () => void;
  /** False when the host runtime owns the notification baseline (multi-host). */
  notify?: boolean;
  /** False when HostFrame already renders the shell for this workbench. */
  framed?: boolean;
  /** The ready host's opening tracker; absent for token clients. */
  hostOpening?: Opening;
  hostOpen?: (id: ConversationId) => void;
  hostCancelOpening?: () => void;
}) {
  const view = useDurableView(remote);
  const { hosts, focus, focusConversation, focusDraft, rememberConversation } = useHosts();
  // A draft create resolves after an arbitrary delay. Record the latest focus
  // so a same-host selection made while it was in flight wins.
  const focusRef = useRef(focus);
  focusRef.current = focus;
  // A draft create or a fork's first submit resolves after an arbitrary delay;
  // if focus moved to another host meanwhile, this workbench is gone and must
  // not pull it back.
  const live = useRef(true);
  useEffect(() => {
    // StrictMode runs the cleanup/setup pair once on mount; restore the flag
    // in setup so the still-mounted workbench keeps handling its create.
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  // One fork at a time per workbench. The invisible side stages the new fork
  // until its summary proves parent and forkedAt; main stays on the parent
  // throughout, so focus keeps its ordinary single responsibility.
  const forkOp = useRef<ForkOperation | null>(null);
  const [forkBusy, setForkBusy] = useState(false);
  const finishFork = useCallback((op: ForkOperation) => {
    if (forkOp.current !== op) return;
    forkOp.current = null;
    if (live.current) setForkBusy(false);
  }, []);
  const settleForkIfDone = useCallback(
    (op: ForkOperation) => {
      if (forkOp.current !== op || !op.commandSettled) return;
      if (op.confirmed || op.cancelled) {
        finishFork(op);
        return;
      }
      const side = remote.view.current().side;
      // A different side may be the staged fork whose snapshot/summary has not
      // arrived yet; let the handoff effect identify it. No side, or the old
      // user side still shown, means this command staged nothing.
      if (side !== undefined && side.id !== op.sideBeforeId) return;
      finishFork(op);
    },
    [finishFork, remote],
  );
  // The 5.12 name the connected host announced rides back into the stored
  // entry — bound to this connection's hostKey, not whichever host is focused.
  useHostNameSync(hostKey, view.settings);
  // In the stored-host root, focus owns whether this workbench is a draft: a
  // sidebar click can start one without rendering through this component.
  // A one-shot token or device-link client has no focus entry and keeps the
  // local state.
  const [localDrafting, setLocalDrafting] = useState(true);
  const drafting = framed
    ? localDrafting
    : focus !== null && focus.hostKey === hostKey && focus.conversationId === undefined;
  // The draft home lives on the host's new-draft slot: it survives this
  // workbench being unmounted by a focus switch.
  const newDraftSlot = useComposerSlot();
  const draft = useComposerSlotState(newDraftSlot).home;
  // Token clients learn drafting from the snapshot; the stored-host root reads
  // it from focus instead.
  useEffect(() => {
    if (framed) setLocalDrafting(view.conversation === undefined);
  }, [framed, view.conversation?.conversation.id]);
  // Opening a conversation moves the main column to it at once; the remote
  // only shows it once its snapshot lands, so until then the column holds a
  // skeleton (or, if the switch failed, says so) instead of the old one.
  // A stored host shares its focus effect's tracker; token clients keep their own.
  const localOpening = useConversationOpening(remote);
  const opening = hostOpening ?? localOpening.opening;
  const openTarget = hostOpen ?? localOpening.open;
  const cancelOpening = hostCancelOpening ?? localOpening.cancel;
  const openConversation = useCallback(
    (id: ConversationId): void => {
      if (framed) setLocalDrafting(false);
      // Only the multi-host ReadyHost route owns app focus. A one-shot
      // connection may carry a hostKey without that composition and opens its
      // own main slot directly.
      if (hostOpen !== undefined && hostKey !== undefined) {
        focusConversation({ hostKey, conversationId: id });
      } else {
        openTarget(id);
      }
    },
    [focusConversation, framed, hostKey, hostOpen, openTarget],
  );
  // The fork call stages the new fork on the invisible side. Main stays on the
  // parent; only the summary proves parent and forkedAt and lets us follow.
  useEffect(() => {
    const op = forkOp.current;
    if (op === null || op.confirmed || op.cancelled) return;
    const cancel = (): void => {
      op.cancelled = true;
      if (op.stagedId !== undefined && remote.view.current().side?.id === op.stagedId) {
        void remote.controller.showSide(undefined);
      }
      settleForkIfDone(op);
    };
    // Any ordinary main switch or focus move means the reader left the parent:
    // do not follow the staged fork.
    const mainId = view.conversation?.conversation.id;
    if (mainId !== undefined && mainId !== op.parentId) {
      cancel();
      return;
    }
    if (
      hostOpen !== undefined
      && hostKey !== undefined
      && (focus?.hostKey !== hostKey || focus.conversationId !== op.parentId)
    ) {
      cancel();
      return;
    }
    const side = view.side;
    // The command may not have reached showSide yet; the old side is expected.
    if (!op.commandSettled && (side === undefined || side.id === op.sideBeforeId)) return;
    if (side === undefined || side.id === op.sideBeforeId) {
      cancel();
      return;
    }
    if (op.stagedId !== undefined && side.id !== op.stagedId) {
      // A Task detail or another side replaced the stage; never close it.
      cancel();
      return;
    }
    const summary = findConversation(view.organized, side.id)?.summary;
    const summaryMatches =
      summary?.kind === "fork" && summary.parent === op.parentId && summary.forkedAt === op.entryId;
    const parent = side.conversation?.conversation.parent;
    const sideMatches = parent?.conversationId === op.parentId && String(parent.at) === op.entryId;
    if (!summaryMatches && !sideMatches) {
      // No snapshot or summary yet: wait for evidence rather than deciding.
      if (summary === undefined && side.conversation === undefined) return;
      cancel();
      return;
    }
    op.stagedId = side.id;
    if (!summaryMatches) {
      // The side names our parent/entry, but only its summary proves the fork
      // identity required to follow it into main.
      if (summary !== undefined) cancel();
      return;
    }
    op.confirmed = true;
    openConversation(side.id);
    // Retire only the side that is still this staged fork; a Task detail the
    // reader opened instead must not be closed.
    if (remote.view.current().side?.id === side.id) void remote.controller.showSide(undefined);
    settleForkIfDone(op);
  }, [focus, hostKey, hostOpen, openConversation, remote, settleForkIfDone, view.conversation, view.organized, view.side]);
  useRunNotifications(
    view,
    hostKey,
    drafting ? undefined : view.conversation?.conversation.id,
    (ref) => {
      if (hostKey === undefined) {
        setLocalDrafting(false);
        openTarget(ref.conversationId);
      } else {
        focusConversation(ref);
      }
    },
    notify,
  );
  const loading = !drafting && opening !== undefined && view.conversation?.conversation.id !== opening.id;
  const failed = loading && opening.failed;
  const conversation = drafting || loading ? undefined : view.conversation;
  // A switch the connection dropped retries once the host is back; one the
  // host refused while connected waits for the reader's "Try again".
  useEffect(() => {
    if (failed && view.connection === "connected") openTarget(opening.id);
  }, [failed, openTarget, opening?.id, view.connection]);
  const shownId = drafting
    ? undefined
    : loading
      ? opening.id
      : !framed && hostKey !== undefined
        ? focus?.conversationId
        : view.conversation?.conversation.id;
  const busy = conversation !== undefined && isBusy(conversation);
  // Below this the chat column would be squeezed; the panel opens as a dialog.
  const narrow = useMediaQuery("(max-width: 1023px)");
  // The overview card's open state survives reloads; starting a conversation
  // opens it so the header button is learned — except on a phone, where the
  // card would cover the exchange that just began.
  const [overviewOpen, setOverviewOpen] = useState(readOverviewOpen);
  const changeOverview = (open: boolean): void => {
    window.localStorage.setItem(OVERVIEW_OPEN_KEY, String(open));
    setOverviewOpen(open);
  };
  // The side panel's open state and surface live here so chat entries and the
  // overview can open it on the surface they name (ADR-0040). The surface
  // last shown is remembered; the panel itself starts closed.
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelSurface, setPanelSurface] = useState(readPanelSurface);
  const openSurface = useCallback((surface: PanelSurface) => {
    window.localStorage.setItem(PANEL_SURFACE_KEY, surface);
    setPanelSurface(surface);
    setPanelOpen(true);
  }, []);
  // The shown surface's icon closes the panel; any other opens its surface.
  const selectSurface = (surface: PanelSurface): void => {
    if (panelOpen && surface === panelSurface) setPanelOpen(false);
    else openSurface(surface);
  };
  // A failed/unconfirmed send edited from the transcript flows back into the
  // composer that owns skill picks and attachment chips. Bind the draft to the
  // conversation it came from: switching away must not fill another composer.
  const [takeBack, setTakeBack] = useState<PendingTakeBack>();
  const [takingBack, setTakingBack] = useState<ConversationId>();
  const [editorState, setEditorState] = useState({ occupied: false, locked: false });
  const toast = useToast();
  // Create the fork on the invisible side first, then hand it to main once the
  // summary proves its parent and forkedAt. Main stays on the parent until
  // then; no focus hold is involved.
  const createFork = useCallback(
    async (entryId: string, text: string): Promise<void> => {
      if (forkOp.current !== null) return;
      const current = remote.view.current();
      const parentId = current.conversation?.conversation.id;
      if (parentId === undefined) return;
      const op: ForkOperation = {
        parentId,
        entryId,
        sideBeforeId: current.side?.id,
        stagedId: undefined,
        confirmed: false,
        cancelled: false,
        commandSettled: false,
      };
      forkOp.current = op;
      setForkBusy(true);
      try {
        await remote.controller.fork(entryId, text, undefined, { show: "side" });
      } catch (error) {
        if (forkOp.current !== op) return;
        // A transport failure can reject instead of becoming a notice; do not
        // keep waiting for a stage that this command could not hand off.
        op.cancelled = true;
        if (live.current) {
          toast({ description: error instanceof Error ? error.message : String(error), type: "error" });
        }
      } finally {
        if (forkOp.current === op) {
          op.commandSettled = true;
          settleForkIfDone(op);
        }
      }
    },
    [remote, settleForkIfDone, toast],
  );
  const shownConversationId = conversation?.conversation.id;
  const takeBackForShown = takeBackForConversation(takeBack, shownConversationId);
  const takingBackHere = takingBack !== undefined && takingBack === shownConversationId;
  const submissionEditDisabled = editorState.occupied || editorState.locked || takingBack !== undefined;
  const submissionEditTooltip = editorState.occupied
    ? "Clear the composer to edit"
    : submissionEditDisabled
      ? "Finish the current edit first"
      : undefined;
  // "Open in main" promotes a conversation to the main column and closes the side —
  // the family root stays the same, so the close rule below must not fire for it.
  // Fork chips and background subagents from Tasks use it too.
  const openInMain = useCallback(
    (id: ConversationId) => {
      openConversation(id);
      void remote.controller.showSide(undefined);
      // On a phone the panel is a fullscreen dialog: leaving it up would hide
      // the conversation it just promoted.
      if (narrow) setPanelOpen(false);
    },
    [remote, narrow, openConversation],
  );
  const openInPanel = useCallback(
    (id: ConversationId) => {
      // Every subagent opens in the Tasks detail, whatever its lifecycle (ADR-0047 §1).
      openSurface("tasks");
      void remote.controller.showSide(id);
    },
    [remote, openSurface],
  );
  const openTasks = (id?: ConversationId): void => {
    if (id !== undefined) return openInPanel(id);
    void remote.controller.showSide(undefined);
    openSurface("tasks");
  };
  // Keyed on the shown id, not the loaded view: a different family's side
  // closes at the click, and loading inside one family keeps it.
  const familyRootId = shownId === undefined ? undefined : rootOf(view.organized, shownId)?.summary.id;
  // A different family root — another sidebar row, a new conversation, the
  // draft — ends whatever the side was showing.
  useEffect(() => {
    void remote.controller.showSide(undefined);
  }, [familyRootId]);
  const labels = hostLabels(hosts);
  // A stored host's draft can move to another paired machine — to that
  // machine's own draft, untouched by what was typed here (ADR-0035 §7).
  const draftMachine =
    hostKey === undefined || framed
      ? undefined
      : {
          value: hostKey,
          options: hosts.map((host) => ({ value: host.hostKey, label: labels.get(host.hostKey) ?? host.url })),
          onChange: focusDraft,
        };
  const draftLabel = draft.kind === "chat" ? "New chat" : `New conversation in ${projectName(view.organized, draft.path)}`;
  // Any conversation with a parent — fork or subagent — offers a breadcrumb
  // back to the conversation it belongs to.
  const shownSummary = shownId === undefined ? undefined : findConversation(view.organized, shownId)?.summary;
  // A subagent in main is read-only; the user can only stop it (ADR-0047 §2).
  const shownSubagent = shownSummary?.kind === "subagent" ? shownSummary : undefined;
  const canStopShown = shownSubagent !== undefined && canStopSubagent(shownSubagent, view.host?.protocol.minor ?? 0);
  // A subagent's role comes from the delegating call; a top-level conversation
  // or fork shows the agent it currently runs as.
  const headerAgent =
    shownSummary === undefined
      ? undefined
      : shownSummary.kind === "subagent"
        ? shownSummary.role
        : currentAgentOf(shownSummary);
  // The Tasks icon's dot only mirrors the subagents Tasks can show; a fork
  // running where the panel has no row must not light it.
  const liveRoot = shownId === undefined ? undefined : rootOf(view.organized, shownId);
  const liveTasks = liveRoot === undefined ? [] : taskGroupsOf(liveRoot).flatMap((group) => group.tasks);
  const liveProcesses = useProcessList(remote.processes, liveRoot?.summary.id);
  // ADR-0045 §6: the dot means a subagent at work or a live background process.
  const liveActivity = anyAtWork(liveTasks) || (liveProcesses?.processes.some((process) => isProcessActive(process.state)) ?? false);
  const parentId = shownSummary?.parent;
  const parentSummary =
    parentId === undefined ? undefined : findConversation(view.organized, parentId)?.summary;
  const imageLoad = useMemo(
    () => (ref: string, variant: ImageVariant = "original") => remote.controller.image(ref, variant),
    [remote],
  );
  const imageRetryKey = useImageRetryKey(view);
  // Fork depth is one (ADR-0019 §2): inside a fork or a subagent's conversation
  // no run offers the Fork action. An unknown summary — the shown conversation
  // fell out of `organized` (e.g. its root was archived by another client) —
  // also hides it: the host only accepts forks of known root conversations.
  const canFork = shownSummary?.kind === "conversation";
  // A forked message shows the "N forks" chip instead of the Fork button —
  // legacy data can hold several per message (ADR-0019 §3).
  const forksAtForShown = useCallback(
    (entryId: string): ConversationId[] =>
      shownSummary === undefined ? [] : forksAt(view.organized, shownSummary.id, entryId),
    [view.organized, shownSummary],
  );
  // Live summaries power the subagent cards in the transcript.
  const summaryOf = useCallback(
    (id: ConversationId) => findConversation(view.organized, id)?.summary,
    [view.organized],
  );
  const startDraft = (home: Home): void => {
    cancelOpening();
    if (hostKey !== undefined) focusDraft(hostKey);
    newDraftSlot.setHome(home);
    if (framed) setLocalDrafting(true);
  };
  const [forkTarget, setForkTarget] = useState<string>();
  // A successful connect clears the reload-once marker so the next host
  // upgrade may auto-reload again.
  useEffect(() => {
    if (view.connection === "connected") sessionStorage.removeItem(reloadedKey(hostKey));
  }, [hostKey, view.connection]);
  // Only a 4401 close means the pairing itself is bad — other terminal closes
  // (4400's rejected frame, say) keep the disconnect banner and their notice.
  if (view.unauthorized === true && rejected !== undefined) {
    return <Centered>{rejected}</Centered>;
  }
  // The header covers the chat column only; the side panel runs full height
  // beside it, its first row level with the header (ADR-0040).
  const body = (
    <div className="pigui-split flex h-full min-h-0 min-w-0">
      {/* The chat column keeps room for its header's controls; a wide panel shrinks instead. */}
      <div className="pigui-pane flex min-h-0 min-w-[20rem] flex-1 flex-col">
      <FrameHeader
        narrow={narrow}
        title={drafting ? draftLabel : conversationName(shownSummary)}
        {...(headerAgent === undefined ? {} : { agent: headerAgent })}
        parentSummary={parentSummary}
        onBackToParent={openConversation}
        showOverview={shownId !== undefined}
        overviewOpen={overviewOpen}
        onOverviewChange={changeOverview}
        panelControls={
          <SurfaceButtons
            narrow={narrow}
            open={panelOpen}
            surface={panelSurface}
            liveActivity={liveActivity}
            onSelect={selectSurface}
          />
        }
      />
      {notice}
      <ConnectionBanner view={view} wsUrl={wsUrl} hostKey={hostKey} />
        <div className="@container relative flex min-h-0 min-w-0 flex-1 flex-col">
        {shownId === undefined ? (
          <DraftHome
            view={view}
            remote={remote}
            hostKey={hostKey}
            draft={draft}
            onDraft={startDraft}
            {...(draftMachine === undefined ? {} : { machine: draftMachine })}
            onCreated={() => {
              const id = remote.view.current().conversation?.conversation.id;
              if (id === undefined) return;
              // The global New chat remembers where a draft actually became a
              // conversation, even if the reader moved on before it landed.
              if (hostKey !== undefined) writeLastNewHost(window.localStorage, hostKey);
              const stillDrafting =
                hostKey === undefined
                || (focusRef.current?.hostKey === hostKey && focusRef.current.conversationId === undefined);
              if (!live.current) {
                // The create landed while another host was focused. Remember
                // it for this host, but do not pull focus back.
                if (hostKey !== undefined) rememberConversation({ hostKey, conversationId: id });
                return;
              }
              if (stillDrafting) {
                openConversation(id);
                if (!narrow) changeOverview(true);
                return;
              }
              // A same-host selection made while the create was in flight wins;
              // otherwise this host simply remembers its new conversation.
              const choseAnotherConversation =
                focusRef.current?.hostKey === hostKey && focusRef.current.conversationId !== undefined;
              if (hostKey !== undefined && !choseAnotherConversation) {
                rememberConversation({ hostKey, conversationId: id });
              }
            }}
            connected={view.connection === "connected"}
          />
        ) : (
          <ChatLayout
            // Keyed by the shown id, so the skeleton and the content that
            // replaces it share one layout and dock.
            key={`${hostKey ?? "local"}:${shownId}`}
            // The room the overview card needs goes inside the scroll area,
            // so the scrollbar stays on the column's edge.
            className={`motion-safe:transition-[padding] motion-safe:duration-200 motion-safe:ease-out${
              overviewOpen && !narrow ? " pigui-overview-clearance" : ""
            }`}
            style={chatColumn}
            composer={
              // Same 44rem centered column as the message list, so the
              // composer lines up with the conversation at every width.
              <div className="mx-auto w-full max-w-[44rem]">
                {shownSubagent !== undefined ? (
                  <div className="flex items-center gap-2 border-t border-border py-2">
                    <span className="min-w-0 flex-1 text-center text-xs text-muted-foreground">Read-only · subagent</span>
                    {!canStopShown ? null : (
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={view.connection !== "connected"}
                        onClick={() => void remote.controller.abort(shownSubagent.id)}
                      >
                        Stop
                      </Button>
                    )}
                  </div>
                ) : conversation === undefined ? (
                  failed ? null : <ComposerSkeleton />
                ) : (
                  <div className="flex flex-col gap-1">
                    <PendingQuestions docs={view.docs} remote={remote} connected={view.connection === "connected"} />
                    <ConversationComposer
                      view={view}
                      remote={remote}
                      conversation={conversation}
                      busy={busy}
                      narrow={narrow}
                      takeBack={takeBackForShown}
                      externalEditLocked={takingBackHere}
                      onEditorStateChange={setEditorState}
                      source={hostKey}
                      onTakeBack={() => {
                        setTakeBack(undefined);
                        setTakingBack(undefined);
                      }}
                    />
                  </div>
                )}
              </div>
            }
            emptyState={
              failed ? (
                <ConversationUnavailable
                  missing={shownSummary === undefined}
                  connected={view.connection === "connected"}
                  onRetry={() => openTarget(opening.id)}
                />
              ) : (
                <Empty>
                  <EmptyHeader>
                    <EmptyTitle>Nothing here yet</EmptyTitle>
                    <EmptyDescription>Ask the agent something. Every client sees it.</EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )
            }
          >
            {conversation === undefined ? (
              failed ? null : <ConversationSkeleton />
            ) : (
              <ConversationTranscript
                conversation={conversation}
                onLoadEarlier={() => remote.controller.loadEarlier(conversation.conversation.id)}
                docs={view.docs}
                submissions={view.submissions}
                toolPresentations={view.toolPresentations}
                connected={view.connection === "connected"}
                canFork={canFork}
                forkDisabled={forkBusy}
                openInPanel={openInPanel}
                onOpenFork={openInMain}
                onFork={setForkTarget}
                forksAt={forksAtForShown}
                summaryOf={summaryOf}
                submissionEditDisabled={submissionEditDisabled}
                submissionEditTooltip={submissionEditTooltip}
                // A subagent's run belongs to the delegating task; resending its prompt would talk past it.
                onRetry={
                  shownSummary?.kind === "subagent"
                    ? undefined
                    : async ({ text, images, skills, attachments, requestId }) => {
                        requestNotificationPermission();
                        // Refs go back as refs (outgoingImage), never downloaded first.
                        await remote.controller.submit(text, "followUp", {
                          requestId,
                          images: images.map(outgoingImage),
                          ...(images.some((image) => !("data" in image)) ? { imageViews: images } : {}),
                          skills,
                          ...(attachments.length === 0 ? {} : { attachments: attachments.map((file) => file.id) }),
                          ...(attachments.length === 0 ? {} : { attachmentDetails: attachments }),
                        });
                      }
                }
                onRetrySubmission={
                  shownSummary?.kind === "subagent"
                    ? undefined
                    : (requestId) => {
                        void remote.controller.retrySubmission(requestId).catch(() => {});
                      }
                }
                onEditSubmission={
                  shownSummary?.kind === "subagent"
                    ? undefined
                    : (requestId) => {
                        const origin = shownConversationId;
                        if (submissionEditDisabled || origin === undefined) return;
                        setTakingBack(origin);
                        void remote.controller
                          .takeBackSubmission(requestId)
                          .then((draft) => {
                            if (draft !== undefined) setTakeBack({ conversationId: origin, draft });
                            else setTakingBack(undefined);
                          })
                          .catch((error: unknown) => {
                            setTakingBack(undefined);
                            toast({ description: error instanceof Error ? error.message : String(error), type: "error" });
                          });
                      }
                }
              />
            )}
          </ChatLayout>
        )}
          {overviewOpen && conversation !== undefined ? (
            <OverviewCard
              view={view}
              remote={remote}
              conversation={conversation}
              narrow={narrow}
              busy={isBusy(conversation)}
              onOpenChanges={() => openSurface("changes")}
              onOpenTasks={openTasks}
              onClose={() => changeOverview(false)}
            />
          ) : null}
        </div>
      </div>
      {!narrow ? (
        <SidePanel
          view={view}
          remote={remote}
          shownId={shownId}
          narrow={false}
          open={panelOpen}
          surface={panelSurface}
          busy={busy}
          liveActivity={liveActivity}
          onOpenChange={setPanelOpen}
          onSelectSurface={selectSurface}
          openInPanel={openInPanel}
          onOpenInMain={openInMain}
        />
      ) : null}
    </div>
  );
  const extras = (
    <>
      {narrow ? (
        <SidePanel
          view={view}
          remote={remote}
          shownId={shownId}
          narrow
          open={panelOpen}
          surface={panelSurface}
          busy={busy}
          liveActivity={liveActivity}
          onOpenChange={setPanelOpen}
          onSelectSurface={selectSurface}
          openInPanel={openInPanel}
          onOpenInMain={openInMain}
        />
      ) : null}
      {forkTarget === undefined ? null : (
        <ForkDialog
          entryId={forkTarget}
          connected={view.connection === "connected"}
          busy={forkBusy}
          onClose={() => setForkTarget(undefined)}
          onCreate={createFork}
        />
      )}
    </>
  );
  return (
    <ImageSourceProvider
      load={imageLoad}
      retryKey={imageRetryKey}
      {...(hostKey === undefined ? {} : { source: hostKey })}
    >
      {framed ? (
        <AppFrame
          // A one-shot client reaches a single machine.
          machines={[
            {
              key: hostKey ?? "local",
              label: view.settings?.hostName ?? wsUrl,
              view,
              remote,
              ...(hostKey === undefined ? {} : { hostKey }),
              ...(device === undefined ? {} : { device }),
              ...(onReconnect === undefined ? {} : { retry: onReconnect }),
            },
          ]}
          focusKey={hostKey ?? "local"}
          draftingChat={drafting && draft.kind === "chat"}
          shownId={shownId}
          onDraft={(_key, home) => startDraft(home)}
          onOpen={(_key, id) => openConversation(id)}
          onNewChat={() => startDraft({ kind: "chat" })}
          narrow={narrow}
        >
          {body}
          {extras}
        </AppFrame>
      ) : (
        <>
          {body}
          {extras}
        </>
      )}
    </ImageSourceProvider>
  );
}

function ForkDialog({
  entryId,
  connected,
  busy,
  onClose,
  onCreate,
}: {
  entryId: string;
  connected: boolean;
  busy: boolean;
  onClose: () => void;
  /** Creates on the main slot; the workbench adopts and focuses it. */
  onCreate: (entryId: string, prompt: string) => Promise<void>;
}) {
  const [prompt, setPrompt] = useState("Continue from here.");
  const fork = (): void => {
    requestNotificationPermission();
    void onCreate(entryId, prompt.trim());
    onClose();
  };
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())} disablePointerDismissal>
      <DialogContent className="w-[480px]">
        <DialogHeader>
          <DialogTitle>Fork from this answer</DialogTitle>
          <DialogDescription>The fork sees the conversation up to here and works in the same files.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <Field>
            <FieldLabel>First message</FieldLabel>
            <Input
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
            />
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!connected || busy || prompt.trim() === ""}
            onClick={fork}
          >
            {busy ? "Forking…" : "Fork"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ConnectionBanner({
  view,
  wsUrl,
  hostKey,
}: {
  view: DurableView;
  wsUrl: string;
  hostKey?: string;
}) {
  if (view.connection === "outdated") {
    return view.protocolMismatch === undefined ? null : (
      <VersionMismatch wsUrl={wsUrl} mismatch={view.protocolMismatch} {...(hostKey === undefined ? {} : { hostKey })} />
    );
  }
  // The host exits once an upgrade installs (ADR-0043): this drop is the restart.
  if (view.connection === "reconnecting" && view.upgrade?.phase === "installing") {
    return (
      <Alert variant="info" className="rounded-none">
        <AlertTitle>Host is restarting</AlertTitle>
        <AlertDescription>{`Upgrading to pinomad ${view.upgrade.target ?? ""}. Reconnecting when it's back…`}</AlertDescription>
      </Alert>
    );
  }
  if (view.connection === "reconnecting") {
    return (
      <Alert variant="warning" className="rounded-none">
        <AlertTitle>Host connection lost</AlertTitle>
        <AlertDescription>Reconnecting… the view keeps the last state the host sent.</AlertDescription>
      </Alert>
    );
  }
  if (view.connection === "closed") return <Alert variant="destructive" className="rounded-none"><AlertTitle>Disconnected from the host</AlertTitle></Alert>;
  return null;
}

function projectName(organized: DurableView["organized"], path: string): string {
  return organized.projects.find((entry) => entry.project.path === path)?.project.name ?? path.split("/").at(-1) ?? path;
}
