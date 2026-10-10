import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import {
  ChatLayout,
  ChatMessageList,
} from "@astryxdesign/core/Chat";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { HStack, Layout, LayoutContent, LayoutFooter, VStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import type { AgentState, ConversationId } from "@earendil-works/pi-durable";
import { type CSSProperties, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { findConversation, type Home } from "@pinomad/protocol/organization.ts";
import { deriveChat } from "./entities/conversation/cot-view.ts";
import { AppFrame } from "./widgets/app-frame/app-frame.tsx";
import { DraftHome } from "./widgets/draft-home/draft-home.tsx";
import { ConversationComposer } from "./widgets/composer/conversation-composer.tsx";
import { ChatEntryView } from "./widgets/chat/chat-entries.tsx";
import { DiffView } from "./presentation/diff.tsx";
import { PendingQuestions } from "./presentation/question.tsx";
import type { RemoteDurable, RemoteDurableOptions } from "@pinomad/protocol/remote-durable.ts";
import { isBusy } from "@pinomad/protocol/transcript.ts";
import type { DurableView, ProtocolMismatch } from "@pinomad/protocol/view.ts";
import { generateKeyPair, keyPairFromPrivate, type KeyPair } from "@pinomad/protocol/noise.ts";
import { fromBase64Url, secureWebSocketTransport, toBase64Url } from "@pinomad/protocol/secure-channel.ts";
import { DEVICE_KEY, deviceName, pairingFragment, resolveAddress, servedByHost, storedDevice, type ResolvedAddress } from "./address.ts";
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
  const address = useMemo(
    () => resolveAddress(window.location.hash, window.location, localStorage.getItem(DEVICE_KEY)),
    [],
  );
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
  if (address === undefined) {
    return (
      <Centered>
        <NoHostLink />
      </Centered>
    );
  }
  return <Connected address={address} />;
}

/** Where a client with no stored pairing lands: paste a pairing link to pair. */
function NoHostLink() {
  const [pasted, setPasted] = useState("");
  const [error, setError] = useState<string>();
  const connect = (): void => {
    const fragment = pairingFragment(pasted);
    if (fragment === undefined) {
      // Token links deserve the specific hint: they exist, they just can't pair.
      setError(
        /[#?&]token=/.test(pasted)
          ? "Token links can't pair a device — paste a pairing link instead (pinomad pair, or Devices → Pair a device)."
          : "That isn't a pairing link — paste one like http://<host>/#pair=… or pinomad://pair#pair=…",
      );
      return;
    }
    window.location.hash = fragment;
    window.location.reload();
  };
  return (
    <VStack gap={4} hAlign="center" style={{ width: "100%", maxWidth: 420 }}>
      <EmptyState
        title="No host link"
        description="Paste a pairing link from pinomad pair or Devices → Pair a device."
      />
      <HStack gap={2} vAlign="end" style={{ width: "100%" }}>
        <div className="min-w-0 flex-1">
          <TextInput
            label="Pairing link"
            isLabelHidden
            placeholder="http://…/#pair=… or pinomad://pair#…"
            value={pasted}
            onChange={(value) => {
              setError(undefined);
              setPasted(value);
            }}
            onEnter={connect}
            width="100%"
          />
        </div>
        <Button label="Connect" variant="primary" isDisabled={pasted.trim() === ""} onClick={connect} />
      </HStack>
      {error === undefined ? null : <Banner status="error" title="Not a pairing link" description={error} />}
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
  const stored = useMemo(() => storedDevice(localStorage.getItem(DEVICE_KEY)), []);
  const replacing = stored !== undefined && stored.hostKey !== address.hostKey;
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
  const stored = useMemo(() => storedDevice(localStorage.getItem(DEVICE_KEY)), []);
  const device = useMemo<KeyPair>(() => {
    // A stored key for the same host survives a spent pairing link: the host
    // admits a registered device without consuming the offer.
    if (address.kind === "pair" && stored !== undefined && stored.hostKey === address.hostKey) {
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
                localStorage.setItem(
                  DEVICE_KEY,
                  JSON.stringify({ url: address.url, hostKey: address.hostKey, privateKey: toBase64Url(device.privateKey) }),
                );
                // The fragment held a one-time secret; it must not linger in history.
                history.replaceState(null, "", window.location.pathname + window.location.search);
              },
            }
          : {}),
      }),
    }),
    [address, device],
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
        {stored === undefined ? null : (
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
            localStorage.removeItem(DEVICE_KEY);
            window.location.reload();
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
    // host keeps the key and the banner.
    return (
      <Centered>
        {state.mismatch !== undefined ? (
          <VersionMismatch wsUrl={label} mismatch={state.mismatch} />
        ) : rejected !== undefined && state.unauthorized ? (
          rejected
        ) : (
          <Banner status="error" title="Could not connect to the host" description={state.error} />
        )}
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
  const items = useMemo(
    () => (conversation === undefined ? [] : deriveChat(conversation, view.toolPresentations, busy)),
    [conversation, view.toolPresentations, busy],
  );
  const draftLabel = draft.kind === "chat" ? "New chat" : `New conversation in ${projectName(view.organized, draft.path)}`;
  // A shown subagent conversation offers a breadcrumb back to the run that owns it.
  const shownSummary =
    conversation === undefined
      ? undefined
      : findConversation(view.organized, conversation.conversation.id)?.summary;
  const parentId = shownSummary?.kind === "subagent" ? shownSummary.parent : undefined;
  const parentSummary =
    parentId === undefined ? undefined : findConversation(view.organized, parentId)?.summary;
  const openConversation = useCallback((id: ConversationId) => void remote.controller.switchConversation(id), [remote]);
  // Fork depth is one (ADR-0019 §2): inside a fork or a subagent's conversation
  // no run offers the Fork action.
  const canFork = shownSummary === undefined || shownSummary.kind === "conversation";
  // One fork per message (ADR-0019 §3): a run whose entry was already forked
  // reopens that fork instead of the dialog.
  const forkAt = useCallback(
    (entryId: string): ConversationId | undefined =>
      shownSummary === undefined
        ? undefined
        : findConversation(view.organized, shownSummary.id)?.children.find((child) => child.summary.forkedAt === entryId)
            ?.summary.id,
    [view.organized, shownSummary],
  );
  const startDraft = (home: Home): void => {
    setDraft(home);
    setDrafting(true);
  };
  // Below this the chat column would be squeezed; the dock opens as a dialog.
  const narrow = useMediaQuery("(max-width: 1023px)");
  const [forkTarget, setForkTarget] = useState<string>();
  const [changesOpen, setChangesOpen] = useState(false);
  // A successful connect clears the reload-once marker so the next host
  // upgrade may auto-reload again.
  useEffect(() => {
    if (view.connection === "connected") sessionStorage.removeItem(RELOADED_KEY);
  }, [view.connection]);
  // Only a 4401 close means the pairing itself is bad — other terminal closes
  // (4400's rejected frame, say) keep the disconnect banner and their notice.
  if (view.unauthorized === true && rejected !== undefined) return <Centered>{rejected}</Centered>;
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
                  <PendingQuestions view={view} remote={remote} />
                  <ConversationComposer view={view} remote={remote} conversation={conversation} busy={busy} narrow={narrow} />
                </VStack>
              </div>
            }
            emptyState={<EmptyState title="Nothing here yet" description="Ask the agent something. Every client sees it." />}
          >
            {items.length === 0 ? null : (
              <ChatMessageList isStreaming={busy} gap={0}>
                {/* Pace's live-session-column gutter: centered column
                    with horizontal padding; chat.css's CoT rail
                    expects that breathing room at the left edge. */}
                <div className="mx-auto flex w-full max-w-[44rem] flex-col gap-8 px-4 pb-6 pt-2">
                  {items.map((item) => (
                    <ChatEntryView
                      key={item.id}
                      entry={item}
                      connected={view.connection === "connected"}
                      openConversation={openConversation}
                      onFork={setForkTarget}
                      canFork={canFork}
                      forkAt={forkAt}
                    />
                  ))}
                </div>
              </ChatMessageList>
            )}
          </ChatLayout>
        )}
      </AppFrame>
      {forkTarget === undefined ? null : (
        <ForkDialog entryId={forkTarget} remote={remote} connected={view.connection === "connected"} onClose={() => setForkTarget(undefined)} />
      )}
      {changesOpen && conversation !== undefined && (
        <ChangesDialog view={view} remote={remote} busy={busy} onClose={() => setChangesOpen(false)} />
      )}
    </>
  );
}

function ForkDialog({ entryId, remote, connected, onClose }: { entryId: string; remote: RemoteDurable; connected: boolean; onClose: () => void }) {
  const [prompt, setPrompt] = useState("Continue from here.");
  const fork = (): void => {
    void remote.controller.fork(entryId, prompt.trim());
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
