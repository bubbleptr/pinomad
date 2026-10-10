import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { ChatLayout } from "@astryxdesign/core/Chat";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { HStack, Layout, LayoutContent, LayoutFooter, VStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import type { AgentState, ConversationId } from "@earendil-works/pi-durable";
import { type CSSProperties, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { findConversation, type Home } from "@pinomad/protocol/organization.ts";
import { displayName, forksAt, rootOf } from "./entities/conversation/family.ts";
import { AppFrame } from "./widgets/app-frame/app-frame.tsx";
import { DraftHome } from "./widgets/draft-home/draft-home.tsx";
import { ConversationComposer } from "./widgets/composer/conversation-composer.tsx";
import { ConversationTranscript } from "./widgets/chat/conversation-transcript.tsx";
import type { PanelTab } from "./widgets/side-panel/side-panel.tsx";
import { DiffView } from "./presentation/diff.tsx";
import { PendingQuestions } from "./presentation/question.tsx";
import type { RemoteDurable, RemoteDurableOptions } from "@pinomad/protocol/remote-durable.ts";
import { isBusy } from "@pinomad/protocol/transcript.ts";
import type { DurableView, ProtocolMismatch } from "@pinomad/protocol/view.ts";
import { generateKeyPair, keyPairFromPrivate, type KeyPair } from "@pinomad/protocol/noise.ts";
import { fromBase64Url, secureWebSocketTransport, toBase64Url } from "@pinomad/protocol/secure-channel.ts";
import { deviceName, resolveAddress, servedByHost, type ResolvedAddress, type StoredHost } from "./address.ts";
import { ACTIVE_HOST_KEY, HostsContext, hostStore, useHosts, type HostsState } from "./entities/host/host-store.ts";
import { PairingLinkForm } from "./entities/host/pairing-link-form.tsx";
import { HostSwitcherFallback } from "./widgets/app-frame/host-switcher.tsx";
import { useDurableView, useRemoteDurable } from "./use-remote.ts";
import { hostWindowChrome } from "./shared/host-chrome.ts";

const page: CSSProperties = {
  height: "100dvh",
  width: "100%",
  backgroundColor: "var(--color-background-body)",
  color: "var(--color-text-primary)",
};
const chatColumn: CSSProperties = { flex: 1, minHeight: 0 };

export function App() {
  const [store] = useState(hostStore);
  // The host list resolves once: switching hosts reloads the page, so nothing
  // downstream reacts to store changes after this load.
  const [loaded, setLoaded] = useState<{
    hosts: readonly StoredHost[];
    activeHostKey: string | null;
    address: ResolvedAddress | undefined;
  }>();
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
        const activeHostKey = localStorage.getItem(ACTIVE_HOST_KEY);
        setLoaded({
          hosts,
          activeHostKey,
          // Resolve exactly once: pairing clears the fragment before it updates
          // the list, so re-resolving on render would flip a pair address into
          // a device one and remount the client — a second connection.
          address: resolveAddress(window.location.hash, window.location, hosts, activeHostKey),
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
  const state = useMemo<HostsState>(
    () =>
      loaded === undefined
        ? { store, hosts: [], activeHostKey: null, paired: () => Promise.resolve() }
        : {
            store,
            hosts: loaded.hosts,
            activeHostKey: loaded.activeHostKey,
            paired: async (host) => {
              await store.save(host);
              localStorage.setItem(ACTIVE_HOST_KEY, host.hostKey);
              setLoaded((prev) =>
                prev === undefined
                  ? prev
                  : {
                      ...prev,
                      hosts: [...prev.hosts.filter((each) => each.hostKey !== host.hostKey), host],
                      activeHostKey: host.hostKey,
                    },
              );
            },
          },
    [store, loaded],
  );
  if (loaded === undefined) return <Centered>{null}</Centered>;
  const { address } = loaded;
  return (
    <HostsContext.Provider value={state}>
      {address === undefined ? (
        <Centered>
          <NoHostLink />
        </Centered>
      ) : (
        <Connected address={address} />
      )}
    </HostsContext.Provider>
  );
}

/** Where a client with no stored pairing lands: paste a pairing link to pair. */
function NoHostLink() {
  return (
    <VStack gap={4} hAlign="center" style={{ width: "100%", maxWidth: 420 }}>
      <EmptyState
        title="No host link"
        description="Paste a pairing link from pinomad pair or Devices → Pair a device."
      />
      <PairingLinkForm />
    </VStack>
  );
}

export function Centered({ children }: { children: ReactNode }) {
  // These screens have no header to drag the hidden-title-bar window by.
  const reserveStrip = hostWindowChrome().reserveMacTrafficLights;
  return (
    <VStack style={page} isScrollable>
      {reserveStrip ? <div aria-hidden="true" className="pinomad-drag fixed inset-x-0 top-0 h-10" /> : null}
      <VStack minHeight="100%" style={{ flexShrink: 0 }} hAlign="center" vAlign="center" padding={6}>
        {children}
      </VStack>
    </VStack>
  );
}

function Connected({ address }: { address: ResolvedAddress }) {
  if (address.kind === "token") {
    return <RemoteWorkbench options={address} connectionKey={`${address.url} ${address.token}`} label={address.url} />;
  }
  if (address.kind === "pair") return <PairConfirm address={address} />;
  return <SecureClient address={address} />;
}

/**
 * A pair link opens a socket only after the user has seen which host it is:
 * pairing with an attacker-controlled host would register this device and
 * (while the client keeps one key) replace its stored pairing — for every
 * pair link, browser QR or pasted, one uniform rule.
 */
function PairConfirm({ address }: { address: Extract<ResolvedAddress, { kind: "pair" }> }) {
  const [confirmed, setConfirmed] = useState(false);
  const { store, hosts } = useHosts();
  // Only a single-device store is overwritten by pairing; the desktop keeps
  // every host it has paired.
  const replacing = !store.multiHost && hosts[0] !== undefined && hosts[0].hostKey !== address.hostKey;
  const cancel = (): void => {
    history.replaceState(null, "", window.location.pathname + window.location.search);
    window.location.reload();
  };
  if (confirmed) return <SecureClient address={address} />;
  const target = new URL(address.url);
  return (
    <Centered>
      <VStack gap={4} hAlign="center" style={{ maxWidth: 420 }}>
        <EmptyState title="Pair with this host?" description={`This device will pair with ${target.host}.`} />
        {replacing ? (
          <Banner
            status="warning"
            title="Replaces your current pairing"
            description="This device is already paired with a different host — pairing again replaces it."
          />
        ) : null}
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
function SecureClient({ address }: { address: Extract<ResolvedAddress, { kind: "pair" | "device" }> }) {
  const { store, hosts, paired } = useHosts();
  const stored = useMemo(() => hosts.find((host) => host.hostKey === address.hostKey), [hosts, address]);
  const device = useMemo<KeyPair>(() => {
    // A stored key for the same host survives a spent pairing link: the host
    // admits a registered device without consuming the offer.
    if (address.kind === "pair" && stored !== undefined) {
      return keyPairFromPrivate(fromBase64Url(stored.privateKey));
    }
    return address.kind === "device" ? keyPairFromPrivate(fromBase64Url(address.privateKey)) : generateKeyPair();
  }, [address, stored]);
  const options = useMemo<RemoteDurableOptions>(
    () => ({
      transport: secureWebSocketTransport({
        url: address.url,
        hostKey: fromBase64Url(address.hostKey),
        device,
        ...(address.kind === "pair"
          ? {
              pairing: { secret: address.secret, name: deviceName(navigator.userAgent) },
              onPaired: () => {
                void paired({
                  url: address.url,
                  hostKey: address.hostKey,
                  privateKey: toBase64Url(device.privateKey),
                }).catch((error: unknown) => console.error("Could not save the paired host", error));
                // The fragment held a one-time secret; it must not linger in history.
                history.replaceState(null, "", window.location.pathname + window.location.search);
              },
            }
          : {}),
      }),
    }),
    [address, device, paired],
  );
  const rejected =
    address.kind === "pair" ? (
      // A pairing offer is single-use; a rejected one is the offer's problem,
      // not this device's — never offer to wipe a saved pairing from here.
      <VStack gap={4} hAlign="center">
        <EmptyState
          title="This pairing code was used or has expired"
          description="Generate a new QR on the host: run bun run pair, or open Devices → Pair a device."
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
        <Button
          label="Forget this host"
          variant="secondary"
          onClick={() => {
            // Reload lands on another stored host, or the no-link screen when
            // none remain; a stale active key falls back to the first host.
            if (localStorage.getItem(ACTIVE_HOST_KEY) === address.hostKey) {
              localStorage.removeItem(ACTIVE_HOST_KEY);
            }
            void store.remove(address.hostKey).finally(() => window.location.reload());
          }}
        />
      </VStack>
    );
  return (
    <RemoteWorkbench
      options={options}
      connectionKey={`${address.url} ${address.hostKey}`}
      label={address.url}
      rejected={rejected}
      device={device}
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
}: {
  options: RemoteDurableOptions;
  connectionKey: string;
  label: string;
  /** Secure-channel 4401: pairing failed or the device was revoked. */
  rejected?: ReactNode;
  /** This browser's device key, for marking "This device" in the devices list. */
  device?: KeyPair;
}) {
  const state = useRemoteDurable(options, connectionKey);
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
    // multi-host gets its switcher inline (a no-op in the browser).
    return (
      <Centered>
        {state.mismatch !== undefined ? (
          <VersionMismatch wsUrl={label} mismatch={state.mismatch} />
        ) : rejected !== undefined && state.unauthorized ? (
          rejected
        ) : (
          <Banner status="error" title="Could not connect to the host" description={state.error} />
        )}
        <HostSwitcherFallback />
      </Centered>
    );
  }
  return <Workbench remote={state.remote} wsUrl={label} rejected={rejected} device={device} />;
}

/**
 * The host speaks a protocol this bundle doesn't. A page the host itself
 * serves reloads once to fetch the matching bundle — the sessionStorage
 * marker is the loop guard (a still-mismatching reload shows the banner);
 * a successful connect clears it so the next upgrade reloads again.
 */
const RELOADED_KEY = "pinomad.reloadedForProtocol";

function VersionMismatch({ wsUrl, mismatch }: { wsUrl: string; mismatch: ProtocolMismatch }) {
  const [reloading] = useState(() => {
    if (!servedByHost(wsUrl, window.location)) return false;
    if (sessionStorage.getItem(RELOADED_KEY) === String(mismatch.hostMajor)) return false;
    sessionStorage.setItem(RELOADED_KEY, String(mismatch.hostMajor));
    window.location.reload();
    return true;
  });
  if (reloading) return null;
  const version = mismatch.hostVersion === undefined ? "" : ` Host version: ${mismatch.hostVersion}.`;
  return mismatch.direction === "client-older" ? (
    <Banner
      status="error"
      container="section"
      title="Client out of date"
      description={`The host speaks a newer protocol. Reload the page, or update the app.${version}`}
    />
  ) : (
    <Banner
      status="error"
      container="section"
      title="Host out of date"
      description={`This client speaks a newer protocol. Upgrade the host (pinomad upgrade).${version}`}
    />
  );
}

function Workbench({ remote, wsUrl, rejected, device }: { remote: RemoteDurable; wsUrl: string; rejected?: ReactNode; device?: KeyPair }) {
  const view = useDurableView(remote);
  // `drafting` starts true: after connect nothing is shown, and the composer
  // creates a conversation at the draft's home instead of prompting it.
  const [drafting, setDrafting] = useState(true);
  const [draft, setDraft] = useState<Home>({ kind: "chat" });
  // The shown conversation's identity decides drafting; creating or selecting one
  // leaves it, archiving the shown one or "New chat" enters it.
  useEffect(() => setDrafting(view.conversation === undefined), [view.conversation?.conversation.id]);
  const conversation = drafting ? undefined : view.conversation;
  const busy = conversation !== undefined && isBusy(conversation);
  // Below this the chat column would be squeezed; the panel opens as a dialog.
  const narrow = useMediaQuery("(max-width: 1023px)");
  // The side panel: open state and tab live here so chat entries can open it.
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelTab, setPanelTab] = useState<PanelTab>("live");
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
      void remote.controller.switchConversation(id);
      void remote.controller.showSide(undefined);
      // On a phone the panel is a fullscreen dialog: leaving it up would hide
      // the conversation it just promoted.
      if (narrow) setPanelOpen(false);
    },
    [remote, narrow],
  );
  const familyRootId =
    conversation === undefined ? undefined : rootOf(view.organized, conversation.conversation.id)?.summary.id;
  // A different family root — another sidebar row, a new conversation, the
  // draft — ends whatever the side was showing.
  useEffect(() => {
    void remote.controller.showSide(undefined);
  }, [familyRootId]);
  const draftLabel = draft.kind === "chat" ? "New chat" : `New conversation in ${projectName(view.organized, draft.path)}`;
  // Any conversation with a parent — fork or subagent — offers a breadcrumb
  // back to the conversation it belongs to.
  const shownSummary =
    conversation === undefined
      ? undefined
      : findConversation(view.organized, conversation.conversation.id)?.summary;
  const parentId = shownSummary?.parent;
  const parentSummary =
    parentId === undefined ? undefined : findConversation(view.organized, parentId)?.summary;
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
    setDraft(home);
    setDrafting(true);
  };
  const [forkTarget, setForkTarget] = useState<string>();
  const [changesOpen, setChangesOpen] = useState(false);
  // A successful connect clears the reload-once marker so the next host
  // upgrade may auto-reload again.
  useEffect(() => {
    if (view.connection === "connected") sessionStorage.removeItem(RELOADED_KEY);
  }, [view.connection]);
  // Only a 4401 close means the pairing itself is bad — other terminal closes
  // (4400's rejected frame, say) keep the disconnect banner and their notice.
  if (view.unauthorized === true && rejected !== undefined) {
    return (
      <Centered>
        {rejected}
        <HostSwitcherFallback />
      </Centered>
    );
  }
  return (
    <>
      <AppFrame
        view={view}
        remote={remote}
        device={device}
        narrow={narrow}
        drafting={drafting}
        draftingChat={drafting && draft.kind === "chat"}
        draftLabel={draftLabel}
        conversation={conversation}
        summary={shownSummary}
        parentSummary={parentSummary}
        banner={<ConnectionBanner view={view} wsUrl={wsUrl} />}
        onDraft={startDraft}
        onOpenChanges={() => setChangesOpen(true)}
        panelOpen={panelOpen}
        panelTab={panelTab}
        onPanelOpen={setPanelOpen}
        onPanelTab={setPanelTab}
        openInPanel={openInPanel}
        openInMain={openInMain}
      >
        {conversation === undefined ? (
          <DraftHome
            view={view}
            remote={remote}
            draft={draft}
            onDraft={startDraft}
            connected={view.connection === "connected"}
          />
        ) : (
          <ChatLayout
            key={conversation.conversation.id}
            style={chatColumn}
            composer={
              // Same 44rem centered column as the message list, so the
              // composer lines up with the conversation at every width.
              <div className="mx-auto w-full max-w-[44rem]">
                <VStack gap={1}>
                  <PendingQuestions docs={view.docs} remote={remote} connected={view.connection === "connected"} />
                  <ConversationComposer view={view} remote={remote} conversation={conversation} busy={busy} narrow={narrow} />
                </VStack>
              </div>
            }
            emptyState={<EmptyState title="Nothing here yet" description="Ask the agent something. Every client sees it." />}
          >
            <ConversationTranscript
              conversation={conversation}
              toolPresentations={view.toolPresentations}
              connected={view.connection === "connected"}
              canFork={canFork}
              openInPanel={openInPanel}
              onFork={setForkTarget}
              forksAt={forksAtForShown}
              summaryOf={summaryOf}
            />
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
    </>
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

type ChangesResult = { available: false; reason: string } | { available: true; base: string; patch: string; truncated: boolean };

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

function ConnectionBanner({ view, wsUrl }: { view: DurableView; wsUrl: string }) {
  if (view.connection === "outdated") {
    return view.protocolMismatch === undefined ? null : <VersionMismatch wsUrl={wsUrl} mismatch={view.protocolMismatch} />;
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
