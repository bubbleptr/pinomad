import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { ChatLayout } from "@astryxdesign/core/Chat";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { HStack, Layout, LayoutContent, LayoutFooter, VStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useToast } from "@astryxdesign/core/Toast";
import type { ConversationId } from "@earendil-works/pi-durable";
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { CallMethods } from "@pinomad/protocol/frames.ts";

import { outgoingImage, type ImageVariant } from "@pinomad/protocol/images.ts";
import { findConversation, type Home } from "@pinomad/protocol/organization.ts";
import { displayName, forksAt, rootOf } from "@pinomad/client/family.ts";
import { mergeStoredHost, updateStoredHostConnection, updateStoredHostEndpoints } from "@pinomad/client/stored-host.ts";
import { candidatePlan, preferredLegacyUrl } from "@pinomad/protocol/remote-candidates.ts";
import { requestNotificationPermission } from "./entities/conversation/notification-permission.ts";
import { ImageSourceProvider, useImageRetryKey } from "./entities/image/image-source.tsx";
import { useRunNotifications } from "./entities/conversation/use-run-notifications.ts";
import { useConversationOpening, type Opening } from "./entities/conversation/use-conversation-opening.ts";
import { AppFrame } from "./widgets/app-frame/app-frame.tsx";
import { DraftHome } from "./widgets/draft-home/draft-home.tsx";
import { ConversationComposer } from "./widgets/composer/conversation-composer.tsx";
import { takeBackForConversation, type PendingTakeBack } from "./widgets/composer/take-back.ts";
import { ConversationTranscript } from "./widgets/chat/conversation-transcript.tsx";
import { ComposerSkeleton, ConversationSkeleton, ConversationUnavailable } from "./widgets/chat/conversation-skeleton.tsx";
import type { PanelTab } from "./widgets/side-panel/side-panel.tsx";
import { DiffView } from "./presentation/diff.tsx";
import { PendingQuestions } from "./presentation/question.tsx";
import type { RemoteDurable, RemoteDurableOptions } from "@pinomad/protocol/remote-durable.ts";
import { isBusy } from "@pinomad/protocol/transcript.ts";
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
import {
  createHostRuntimeRegistry,
  HostRuntimesContext,
} from "./entities/host/host-runtimes.ts";
import { useComposerSlot, useComposerSlotState } from "./entities/composer/composer-context.tsx";
import { PairingLinkForm } from "./entities/host/pairing-link-form.tsx";
import { HostsFallback } from "./widgets/app-frame/hosts.tsx";
import { AccountProvider, useAccountModel } from "./entities/account/account-context.tsx";
import { AccountPanel } from "./widgets/account/account-panel.tsx";
import { RepairViaAccount } from "./widgets/account/repair-via-account.tsx";
import { useDurableView, useRemoteDurable } from "./use-remote.ts";
import { createBrowserRtcPlatform } from "./entities/host/browser-rtc.ts";
import { secureOptions } from "./entities/host/secure-options.ts";
import { HostRuntimes, type RemoteConnect } from "./entities/host/host-runtime.tsx";
import { Centered } from "./shared/ui/centered.tsx";
import { reloadedKey, VersionMismatch } from "./widgets/app-frame/version-mismatch.tsx";

const chatColumn: CSSProperties = { flex: 1, minHeight: 0 };

const OVERVIEW_OPEN_KEY = "pinomad.overview.open";
const readOverviewOpen = (): boolean =>
  typeof window !== "undefined" && window.localStorage.getItem(OVERVIEW_OPEN_KEY) === "true";

type Loaded = {
  readonly hosts: readonly StoredHost[];
  readonly focus: HostFocus | null;
  readonly address: ResolvedAddress | undefined;
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

  const removeHost = useCallback(
    async (hostKey: string, clearAddress: boolean): Promise<void> => {
      lastByHost.current.delete(hostKey);
      if (clearAddress) {
        // A live #token=…/#pair=… fragment outlives the stored list; drop it so
        // the emptied list can land on the no-link screen instead of reconnecting.
        history.replaceState(null, "", window.location.pathname + window.location.search);
      }
      await store.remove(hostKey).catch((error: unknown) => {
        console.error("Could not remove the host", error);
      });
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
    [rememberedFocus, store],
  );

  /** Remove a superseded identity without treating it as a user forget. */
  const dropHost = useCallback(
    (hostKey: string): Promise<void> => removeHost(hostKey, false),
    [removeHost],
  );

  const forget = useCallback(
    async (hostKey: string): Promise<void> => {
      // Account adoption can link this host in the store without touching the
      // loaded snapshot (or another tab may have done it), so read the latest
      // record before deciding whether forgetting should decline it.
      const persisted = await store.list().catch(() => loaded?.hosts ?? []);
      const host = persisted.find((each) => each.hostKey === hostKey)
        ?? loaded?.hosts.find((each) => each.hostKey === hostKey);
      if (host?.account !== undefined) {
        // A forgotten account host is declined so the next account refresh
        // cannot silently register it again (ADR-0035 §5).
        browserDeclined.add(host.account);
        cancelAccountRegistration(host.account.hostId);
      }
      await removeHost(hostKey, true);
    },
    [loaded?.hosts, removeHost, store],
  );

  const paired = useCallback(
    async (host: StoredHost): Promise<void> => {
      await store.save(host);
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
                  hostOpening={opening}
                  hostOpen={openConversation}
                  hostCancelOpening={cancelOpening}
                />
              )}
            />
          )}
        </AccountProvider>
      </HostRuntimesContext.Provider>
    </HostsContext.Provider>
  );
}

/**
 * Where a client with no stored pairing lands: sign in to pick a host from
 * the account (where this client can reach one), or paste a pairing link.
 */
function NoHostLink() {
  const account = useAccountModel();
  if (account.state.status === "unavailable") {
    return (
      <VStack gap={4} hAlign="center" style={{ width: "100%", maxWidth: 420 }}>
        <EmptyState
          title="No host link"
          description="Paste a pairing link from pinomad pair or Settings → Devices → Pair a device."
        />
        <PairingLinkForm />
      </VStack>
    );
  }
  return (
    <VStack gap={6} style={{ width: "100%", maxWidth: 420 }}>
      <AccountPanel />
      <VStack gap={2}>
        <Text type="supporting">Or paste a pairing link from pinomad pair or Settings → Devices → Pair a device.</Text>
        <PairingLinkForm />
      </VStack>
    </VStack>
  );
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
      <VStack gap={4} hAlign="center" style={{ maxWidth: 420 }}>
        <EmptyState title="Pair with this host?" description={`This device will pair with ${target.host}.`} />
        <Text type="supporting" style={{ wordBreak: "break-all" }}>
          {address.url}
        </Text>
        <HStack gap={2}>
          <Button label="Cancel" variant="secondary" onClick={cancel} />
          <Button label="Pair" variant="primary" onClick={() => setConfirmed(true)} />
        </HStack>
      </VStack>
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
  const { hosts, paired, endpoints, setConnection, forget } = useHosts();
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
      <VStack gap={4} hAlign="center">
        <EmptyState
          title="This pairing code was used or has expired"
          description="Generate a new QR on the host: run bun run pair, or open Settings → Devices → Pair a device."
        />
        {hosts.length === 0 ? null : (
          <Button
            label="Use saved pairing"
            variant="secondary"
            onClick={() => {
              history.replaceState(null, "", window.location.pathname + window.location.search);
              window.location.reload();
            }}
          />
        )}
      </VStack>
    ) : (
      <VStack gap={4} hAlign="center">
        <EmptyState title="This device isn't paired" description="It isn't paired with the host, or was revoked." />
        <RepairViaAccount hostKey={address.hostKey} />
        <Button label="Forget this host" variant="secondary" onClick={() => void forget(address.hostKey)} />
      </VStack>
    );
  const notice =
    unsaved === undefined ? undefined : (
      <Banner
        status="warning"
        container="section"
        title="This pairing wasn't saved"
        description="It will be lost when the app restarts."
        endContent={
          <Button
            label="Retry"
            variant="ghost"
            onClick={() => {
              void paired(unsaved).then(
                () => {
                  setUnsaved(undefined);
                  onPairedHost?.(unsaved);
                },
                (error: unknown) => console.error("Could not save the paired host", error),
              );
            }}
          />
        }
      />
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
        <EmptyState title="Connecting" description={label} />
      </Centered>
    );
  }
  if (state.status === "failed") {
    // Only a 4401 rejection means the pairing itself is bad — an unreachable
    // host keeps the key and the banner. These screens have no sidebar, so
    // the hosts list repeats inline.
    return (
      <Centered>
        {notice === undefined ? null : <div className="w-full max-w-md">{notice}</div>}
        {state.mismatch !== undefined ? (
          <VersionMismatch wsUrl={label} mismatch={state.mismatch} {...(hostKey === undefined ? {} : { hostKey })} />
        ) : rejected !== undefined && state.unauthorized ? (
          rejected
        ) : (
          <VStack gap={4} hAlign="center">
            <Banner
              status="error"
              title={state.direct === undefined ? "Could not connect to the host" : "Direct connection unavailable"}
              description={
                state.direct === undefined
                  ? state.error
                  : "This host can't be reached without the relay, and the peer-to-peer link didn't connect."
              }
            />
            {state.direct === undefined ? null : (
              <Text type="supporting" style={{ textAlign: "center" }}>
                {`Details: ${state.direct.reason}`}
              </Text>
            )}
            {state.direct === undefined ? null : (
              <Text type="supporting" style={{ textAlign: "center" }}>
                Change this host's connection mode under Hosts below, then retry.
              </Text>
            )}
            <Button label="Retry" variant="secondary" onClick={() => setAttempt(attempt + 1)} />
          </VStack>
        )}
        <HostsFallback />
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

function Workbench({
  remote,
  wsUrl,
  rejected,
  device,
  notice,
  hostKey,
  onReconnect,
  notify = true,
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
  /** The ready host's opening tracker; absent for token clients. */
  hostOpening?: Opening;
  hostOpen?: (id: ConversationId) => void;
  hostCancelOpening?: () => void;
}) {
  const view = useDurableView(remote);
  const { focus, focusConversation, focusDraft, rememberConversation } = useHosts();
  // A draft create resolves after an arbitrary delay. Record the latest focus
  // so a same-host selection made while it was in flight wins.
  const focusRef = useRef(focus);
  focusRef.current = focus;
  // A draft create resolves after an arbitrary delay; if focus moved to
  // another host meanwhile, this workbench is gone and must not pull it back.
  const live = useRef(true);
  useEffect(() => {
    // StrictMode runs the cleanup/setup pair once on mount; restore the flag
    // in setup so the still-mounted workbench keeps handling its create.
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  // The 5.12 name the connected host announced rides back into the stored
  // entry — bound to this connection's hostKey, not whichever host is focused.
  useHostNameSync(hostKey, view.settings);
  // `drafting` starts true: after connect nothing is shown, and the composer
  // creates a conversation at the draft's home instead of prompting it.
  const [drafting, setDrafting] = useState(true);
  // The draft home lives on the host's new-draft slot: it survives this
  // workbench being unmounted by a focus switch.
  const newDraftSlot = useComposerSlot();
  const draft = useComposerSlotState(newDraftSlot).home;
  // The shown conversation's identity decides drafting; creating or selecting one
  // leaves it, archiving the shown one or "New chat" enters it.
  useEffect(() => setDrafting(view.conversation === undefined), [view.conversation?.conversation.id]);
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
      setDrafting(false);
      // For a stored host the focus effect performs the one switch; a token
      // client has no focus entry and opens directly.
      if (hostKey !== undefined) focusConversation({ hostKey, conversationId: id });
      else openTarget(id);
    },
    [focusConversation, hostKey, openTarget],
  );
  useRunNotifications(
    view,
    hostKey,
    drafting ? undefined : view.conversation?.conversation.id,
    (ref) => {
      if (hostKey === undefined) {
        setDrafting(false);
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
  const shownId = drafting ? undefined : loading ? opening.id : view.conversation?.conversation.id;
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
  // The side panel: open state and tab live here so chat entries can open it.
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelTab, setPanelTab] = useState<PanelTab>("threads");
  // A failed/unconfirmed send edited from the transcript flows back into the
  // composer that owns skill picks and attachment chips. Bind the draft to the
  // conversation it came from: switching away must not fill another composer.
  const [takeBack, setTakeBack] = useState<PendingTakeBack>();
  const [takingBack, setTakingBack] = useState<ConversationId>();
  const [editorState, setEditorState] = useState({ occupied: false, locked: false });
  const toast = useToast();
  const shownConversationId = conversation?.conversation.id;
  const takeBackForShown = takeBackForConversation(takeBack, shownConversationId);
  const takingBackHere = takingBack !== undefined && takingBack === shownConversationId;
  const submissionEditDisabled = editorState.occupied || editorState.locked || takingBack !== undefined;
  const submissionEditTooltip = editorState.occupied
    ? "Clear the composer to edit"
    : submissionEditDisabled
      ? "Finish the current edit first"
      : undefined;
  const openInPanel = useCallback(
    (id: ConversationId, tab: "threads" | "tasks") => {
      setPanelTab(tab);
      setPanelOpen(true);
      void remote.controller.showSide(id);
    },
    [remote],
  );
  // "Open in main" promotes a thread to the main column and closes the side —
  // the family root stays the same, so the close rule below must not fire for it.
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
  // Keyed on the shown id, not the loaded view: a different family's side
  // closes at the click, and loading inside one family keeps it.
  const familyRootId = shownId === undefined ? undefined : rootOf(view.organized, shownId)?.summary.id;
  // A different family root — another sidebar row, a new conversation, the
  // draft — ends whatever the side was showing.
  useEffect(() => {
    void remote.controller.showSide(undefined);
  }, [familyRootId]);
  const draftLabel = draft.kind === "chat" ? "New chat" : `New conversation in ${projectName(view.organized, draft.path)}`;
  // Any conversation with a parent — fork or subagent — offers a breadcrumb
  // back to the conversation it belongs to.
  const shownSummary = shownId === undefined ? undefined : findConversation(view.organized, shownId)?.summary;
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
    setDrafting(true);
  };
  const [forkTarget, setForkTarget] = useState<string>();
  const [changesOpen, setChangesOpen] = useState(false);
  // A successful connect clears the reload-once marker so the next host
  // upgrade may auto-reload again.
  useEffect(() => {
    if (view.connection === "connected") sessionStorage.removeItem(reloadedKey(hostKey));
  }, [hostKey, view.connection]);
  // Only a 4401 close means the pairing itself is bad — other terminal closes
  // (4400's rejected frame, say) keep the disconnect banner and their notice.
  if (view.unauthorized === true && rejected !== undefined) {
    return (
      <Centered>
        {rejected}
        <HostsFallback />
      </Centered>
    );
  }
  return (
    <ImageSourceProvider
      load={imageLoad}
      retryKey={imageRetryKey}
      {...(hostKey === undefined ? {} : { source: hostKey })}
    >
      <AppFrame
        view={view}
        remote={remote}
        device={device}
        hostKey={hostKey}
        onReconnect={onReconnect}
        narrow={narrow}
        drafting={drafting}
        draftingChat={drafting && draft.kind === "chat"}
        draftLabel={draftLabel}
        conversation={conversation}
        shownId={shownId}
        summary={shownSummary}
        parentSummary={parentSummary}
        banner={
          <>
            {notice}
            <ConnectionBanner view={view} wsUrl={wsUrl} hostKey={hostKey} />
          </>
        }
        onDraft={startDraft}
        onOpenChanges={() => setChangesOpen(true)}
        overviewOpen={overviewOpen}
        onOverviewChange={changeOverview}
        panelOpen={panelOpen}
        panelTab={panelTab}
        onPanelOpen={setPanelOpen}
        onPanelTab={setPanelTab}
        openInPanel={openInPanel}
        openInMain={openInMain}
        onOpen={openConversation}
      >
        {shownId === undefined ? (
          <DraftHome
            view={view}
            remote={remote}
            hostKey={hostKey}
            draft={draft}
            onDraft={startDraft}
            onCreated={() => {
              const id = remote.view.current().conversation?.conversation.id;
              if (id === undefined) return;
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
                {conversation === undefined ? (
                  failed ? null : <ComposerSkeleton />
                ) : (
                  <VStack gap={1}>
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
                  </VStack>
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
                <EmptyState title="Nothing here yet" description="Ask the agent something. Every client sees it." />
              )
            }
          >
            {conversation === undefined ? (
              failed ? null : <ConversationSkeleton />
            ) : (
              <ConversationTranscript
                conversation={conversation}
                docs={view.docs}
                submissions={view.submissions}
                toolPresentations={view.toolPresentations}
                connected={view.connection === "connected"}
                canFork={canFork}
                openInPanel={openInPanel}
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
                onRetrySubmission={(requestId) => {
                  void remote.controller.retrySubmission(requestId).catch(() => {});
                }}
                onEditSubmission={(requestId) => {
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
                      toast({ body: error instanceof Error ? error.message : String(error), type: "error" });
                    });
                }}
              />
            )}
          </ChatLayout>
        )}
      </AppFrame>
      {forkTarget === undefined ? null : (
        <ForkDialog
          entryId={forkTarget}
          remote={remote}
          connected={view.connection === "connected"}
          onClose={() => setForkTarget(undefined)}
          onForked={() => {
            setPanelTab("threads");
            setPanelOpen(true);
          }}
        />
      )}
      {changesOpen && conversation !== undefined && (
        <ChangesDialog view={view} remote={remote} busy={busy} onClose={() => setChangesOpen(false)} />
      )}
    </ImageSourceProvider>
  );
}

function ForkDialog({
  entryId,
  remote,
  connected,
  onClose,
  onForked,
}: {
  entryId: string;
  remote: RemoteDurable;
  connected: boolean;
  onClose: () => void;
  /** The fork opens beside the main conversation — the caller opens the panel. */
  onForked: () => void;
}) {
  const [prompt, setPrompt] = useState("Continue from here.");
  const fork = (): void => {
    requestNotificationPermission();
    void remote.controller.fork(entryId, prompt.trim(), undefined, { show: "side" });
    onForked();
    onClose();
  };
  return (
    <Dialog isOpen onOpenChange={(open) => (open ? undefined : onClose())} purpose="form" width={480}>
      <Layout
        header={
          <DialogHeader
            title="Fork from this answer"
            subtitle="The fork sees the conversation up to here and works in the same files."
            onOpenChange={() => onClose()}
          />
        }
        content={
          <LayoutContent>
            <TextInput label="First message" value={prompt} onChange={setPrompt} />
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} hAlign="end">
              <Button label="Cancel" variant="secondary" onClick={onClose} />
              <Button label="Fork" variant="primary" isDisabled={!connected || prompt.trim() === ""} onClick={fork} />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}

type ChangesResult = CallMethods["changes"]["result"];

/** The conversation's file changes (ADR-0010/0011-B2): a worktree diff vs base, or a project dir's uncommitted diff. */
function ChangesDialog({ view, remote, busy, onClose }: { view: DurableView; remote: RemoteDurable; busy: boolean; onClose: () => void }) {
  const [result, setResult] = useState<ChangesResult>();
  const refresh = useMemo(() => () => void remote.controller.changes().then(setResult).catch(() => {}), [remote]);
  useEffect(refresh, [refresh]);
  // An idle turn may have produced new changes; refresh once when it settles.
  const wasBusy = useRef(busy);
  useEffect(() => {
    if (wasBusy.current && !busy) refresh();
    wasBusy.current = busy;
  }, [busy, refresh]);
  const direct = view.checkout === undefined;
  return (
    <Dialog isOpen onOpenChange={(open) => (open ? undefined : onClose())} width={720}>
      <Layout
        header={<DialogHeader title="Changes" onOpenChange={() => onClose()} />}
        content={
          <LayoutContent>
            <VStack gap={2} padding={3}>
              {result === undefined ? (
                <Text type="supporting">Loading…</Text>
              ) : !result.available ? (
                <Text type="supporting">{result.reason}</Text>
              ) : (
                <>
                  {direct ? (
                    <Text type="supporting">
                      These are the project directory's uncommitted changes, shared with other conversations working there.
                    </Text>
                  ) : null}
                  {result.truncated ? <Text type="supporting">The diff is truncated; the rest is not shown.</Text> : null}
                  <DiffView patch={result.patch} />
                </>
              )}
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} hAlign="end">
              <Button label="Refresh" variant="secondary" isDisabled={view.connection !== "connected"} onClick={refresh} />
              <Button label="Close" variant="primary" onClick={onClose} />
            </HStack>
          </LayoutFooter>
        }
      />
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
  if (view.connection === "reconnecting") {
    return (
      <Banner
        status="warning"
        container="section"
        title="Host connection lost"
        description="Reconnecting… the view keeps the last state the host sent."
      />
    );
  }
  if (view.connection === "closed") return <Banner status="error" container="section" title="Disconnected from the host" />;
  return null;
}

function projectName(organized: DurableView["organized"], path: string): string {
  return organized.projects.find((entry) => entry.project.path === path)?.project.name ?? path.split("/").at(-1) ?? path;
}
