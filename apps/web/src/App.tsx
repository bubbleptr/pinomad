import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import {
  ChatComposer,
  ChatLayout,
} from "@astryxdesign/core/Chat";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { HStack, Layout, LayoutContent, LayoutFooter, LayoutPanel, VStack } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { MobileNav } from "@astryxdesign/core/MobileNav";
import { SideNav, SideNavHeading, SideNavItem, SideNavSection } from "@astryxdesign/core/SideNav";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Switch } from "@astryxdesign/core/Switch";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Token } from "@astryxdesign/core/Token";
import type { AgentState, ConversationId } from "@earendil-works/pi-durable";
import { type CSSProperties, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { findConversation, type ConversationNode, type Home, type Project } from "@pinomad/protocol/organization.ts";
import { queueItems, statusText, taskRows, usageRows } from "./presentation/chat.ts";
import { deriveChat } from "./entities/conversation/cot-view.ts";
import { ChatConversation } from "./shared/ui/chat/chat-conversation.tsx";
import { ChatEntryView } from "./widgets/chat/chat-entries.tsx";
import { DocumentView } from "./presentation/documents.tsx";
import { DiffView } from "./presentation/diff.tsx";
import { PendingQuestions } from "./presentation/question.tsx";
import type { RemoteDurable, RemoteDurableOptions } from "@pinomad/protocol/remote-durable.ts";
import { isBusy } from "@pinomad/protocol/transcript.ts";
import type { DurableView } from "@pinomad/protocol/view.ts";
import { encode } from "uqr";
import { generateKeyPair, keyPairFromPrivate, type KeyPair } from "@pinomad/protocol/noise.ts";
import { fromBase64Url, secureWebSocketTransport, toBase64Url } from "@pinomad/protocol/secure-channel.ts";
import type { DeviceEntry } from "@pinomad/protocol/devices.ts";
import { DEVICE_KEY, deviceName, resolveAddress, servedByHost, storedDevice, type ResolvedAddress } from "./address.ts";
import { useDurableView, useRemoteDurable } from "./use-remote.ts";

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
  if (address === undefined) {
    return (
      <Centered>
        <EmptyState
          title="No host link"
          description="Open the token link the host printed, or scan a pairing QR on this device."
        />
      </Centered>
    );
  }
  return <Connected address={address} />;
}

export function Centered({ children }: { children: ReactNode }) {
  return (
    <VStack style={page} isScrollable>
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
  return <SecureClient address={address} />;
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
          <VersionMismatch wsUrl={label} host={state.mismatch.host} />
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

const agentOf = (conversation: NonNullable<DurableView["conversation"]>): AgentState =>
  (conversation.docs["pi.agent"] ?? {}) as AgentState;

/**
 * The host speaks a protocol this bundle doesn't. A page the host itself
 * serves reloads once to fetch the matching bundle — the sessionStorage
 * marker is the loop guard (a still-mismatching reload shows the banner);
 * a successful connect clears it so the next upgrade reloads again.
 */
const RELOADED_KEY = "pinomad.reloadedForProtocol";

function VersionMismatch({ wsUrl, host }: { wsUrl: string; host: number | string }) {
  const [reloading] = useState(() => {
    if (!servedByHost(wsUrl, window.location)) return false;
    if (sessionStorage.getItem(RELOADED_KEY) === String(host)) return false;
    sessionStorage.setItem(RELOADED_KEY, String(host));
    window.location.reload();
    return true;
  });
  if (reloading) return null;
  return (
    <Banner
      status="error"
      container="section"
      title="Host version mismatch"
      description="The host was upgraded past this client. Reload the page, or update the client you're using."
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
  const home = view.home;
  const homeLabel =
    home === undefined ? undefined : home.kind === "chat" ? "Chat" : projectName(view.organized, home.path);
  const cwd = conversation === undefined ? undefined : agentOf(conversation).cwd;
  const branch = conversation === undefined ? undefined : view.checkout?.branch;
  const draftLabel = draft.kind === "chat" ? "New chat" : `New conversation in ${projectName(view.organized, draft.path)}`;
  // A shown subagent conversation offers a way back to the run that owns it.
  const shownSummary =
    conversation === undefined
      ? undefined
      : findConversation(view.organized, conversation.conversation.id)?.summary;
  const parentId = shownSummary?.kind === "subagent" ? shownSummary.parent : undefined;
  const openConversation = useCallback((id: ConversationId) => void remote.controller.switchConversation(id), [remote]);
  const startDraft = (home: Home): void => {
    setDraft(home);
    setDrafting(true);
  };
  // Below this the chat column would be squeezed; the live state moves into a dialog.
  const narrow = useMediaQuery("(max-width: 1023px)");
  const [navOpen, setNavOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [forkAt, setForkAt] = useState<string>();
  const [changesOpen, setChangesOpen] = useState(false);
  // A successful connect clears the reload-once marker so the next host
  // upgrade may auto-reload again.
  useEffect(() => {
    if (view.connection === "connected") sessionStorage.removeItem(RELOADED_KEY);
  }, [view.connection]);
  // A revoked device is closed with 4401; hooks above stay mounted either way.
  if (view.connection === "closed" && rejected !== undefined) return <Centered>{rejected}</Centered>;
  return (
    <VStack style={page}>
      <Layout
        height="fill"
        start={narrow ? undefined : <ConversationNav view={view} remote={remote} device={device} onDraft={startDraft} />}
        content={
          <LayoutContent padding={0}>
            <VStack height="100%">
              {narrow ? (
                <HStack padding={2} gap={2} hAlign="between">
                  <Button label="Conversations" variant="ghost" onClick={() => setNavOpen(true)} />
                  <Button label="Live state" variant="ghost" onClick={() => setPanelOpen(true)} />
                </HStack>
              ) : null}
              <ConnectionBanner view={view} wsUrl={wsUrl} />
              {conversation === undefined ? (
                <ChatLayout
                  style={chatColumn}
                  composer={<DraftComposer remote={remote} home={draft} connected={view.connection === "connected"} />}
                  emptyState={
                    <EmptyState title={draftLabel} description="The first message creates the conversation." />
                  }
                >
                  {null}
                </ChatLayout>
              ) : (
                <>
                  {homeLabel === undefined ? null : (
                    <HStack padding={2} gap={2} vAlign="center">
                      {parentId === undefined ? null : (
                        <Button
                          label="Back to parent"
                          variant="ghost"
                          size="sm"
                          onClick={() => void remote.controller.switchConversation(parentId)}
                        />
                      )}
                      <Text type="label" weight="semibold">
                        {homeLabel}
                      </Text>
                      {cwd === undefined ? null : (
                        <Text type="supporting" maxLines={1}>
                          {branch === undefined ? cwd : `${branch} · ${cwd}`}
                        </Text>
                      )}
                      <Button label="Changes" variant="ghost" size="sm" onClick={() => setChangesOpen(true)} />
                    </HStack>
                  )}
                  <ChatLayout
                    style={chatColumn}
                    composer={
                      <VStack gap={1}>
                        <PendingQuestions view={view} remote={remote} />
                        <Composer view={view} remote={remote} conversation={conversation} busy={busy} narrow={narrow} />
                      </VStack>
                    }
                    emptyState={<EmptyState title="Nothing here yet" description="Ask the agent something. Every client sees it." />}
                  >
                    {items.length === 0 ? null : (
                      <ChatConversation isStreaming={busy}>
                        {/* Pace's live-session-column gutter: centered column
                            with horizontal padding; chat.css's CoT rail
                            expects that breathing room at the left edge. */}
                        <ChatConversation.Content className="mx-auto flex w-full max-w-[44rem] flex-col gap-8 px-4 pb-6 pt-2">
                          {items.map((item) => (
                            <ChatEntryView
                              key={item.id}
                              entry={item}
                              connected={view.connection === "connected"}
                              openConversation={openConversation}
                              onFork={setForkAt}
                            />
                          ))}
                        </ChatConversation.Content>
                      </ChatConversation>
                    )}
                  </ChatLayout>
                </>
              )}
            </VStack>
          </LayoutContent>
        }
        end={
          narrow ? undefined : (
            <LayoutPanel width={320} hasDivider padding={3} label="Live state">
              <LiveState view={view} remote={remote} />
            </LayoutPanel>
          )
        }
      />
      {narrow ? (
        <MobileNav isOpen={navOpen} onOpenChange={setNavOpen} header="Conversations">
          <ConversationItems view={view} remote={remote} device={device} onDraft={startDraft} onSelect={() => setNavOpen(false)} />
        </MobileNav>
      ) : null}
      {narrow ? (
        <Dialog isOpen={panelOpen} onOpenChange={setPanelOpen} width={360}>
          <Layout
            header={<DialogHeader title="Live state" onOpenChange={setPanelOpen} />}
            content={
              <LayoutContent>
                <LiveState view={view} remote={remote} />
              </LayoutContent>
            }
          />
        </Dialog>
      ) : null}
      {forkAt === undefined ? null : (
        <ForkDialog entryId={forkAt} remote={remote} connected={view.connection === "connected"} onClose={() => setForkAt(undefined)} />
      )}
      {changesOpen && conversation !== undefined && (
        <ChangesDialog view={view} remote={remote} busy={busy} onClose={() => setChangesOpen(false)} />
      )}
    </VStack>
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
            subtitle="The fork sees the conversation up to here and gets its own copy of the files as of now."
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
  if (view.connection === "outdated") return <VersionMismatch wsUrl={wsUrl} host="outdated" />;
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

function ConversationNav({ view, remote, device, onDraft }: { view: DurableView; remote: RemoteDurable; device?: KeyPair; onDraft: (home: Home) => void }) {
  const connection =
    view.connection === "connected" ? (
      <StatusDot variant="success" label="Connected" tooltip="Connected to the host" />
    ) : (
      <StatusDot variant={view.connection === "closed" ? "error" : "warning"} label={view.connection} tooltip={view.connection} isPulsing />
    );
  return (
    <SideNav
      header={<SideNavHeading heading="PiNomad host" subheading={view.session.id} headerEndContent={connection} />}
    >
      <ConversationItems view={view} remote={remote} device={device} onDraft={onDraft} />
    </SideNav>
  );
}

function ConversationItems({
  view,
  remote,
  device,
  onSelect,
  onDraft,
}: {
  view: DurableView;
  remote: RemoteDurable;
  device?: KeyPair;
  onSelect?: () => void;
  onDraft: (home: Home) => void;
}) {
  const disabled = view.connection !== "connected";
  const [addOpen, setAddOpen] = useState(false);
  const [devicesOpen, setDevicesOpen] = useState(false);
  const [removing, setRemoving] = useState<Project>();
  const start = (home: Home): void => {
    onDraft(home);
    onSelect?.();
  };
  return (
    <>
      <SideNavSection
        title="Chats"
        endContent={
          <Button label="New chat" variant="ghost" size="sm" isDisabled={disabled} onClick={() => start({ kind: "chat" })} />
        }
      >
        {view.organized.chats.map((node) => (
          <ConversationNodeItem
            key={node.summary.id}
            node={node}
            depth={0}
            shown={view.conversation?.conversation.id}
            disabled={disabled}
            remote={remote}
            onSelect={onSelect}
          />
        ))}
      </SideNavSection>
      {view.organized.projects.map(({ project, conversations }) => (
        <SideNavSection
          key={project.path}
          title={project.name}
          endContent={
            <DropdownMenu
              button={{ label: "Actions", variant: "ghost", size: "sm", isDisabled: disabled }}
              items={[
                { label: "New conversation", onClick: () => start({ kind: "project", path: project.path }) },
                { label: "Remove project", onClick: () => setRemoving(project) },
              ]}
            />
          }
        >
          {conversations.map((node) => (
            <ConversationNodeItem
              key={node.summary.id}
              node={node}
              depth={0}
              shown={view.conversation?.conversation.id}
              disabled={disabled}
              remote={remote}
              onSelect={onSelect}
            />
          ))}
        </SideNavSection>
      ))}
      <SideNavItem label="Add project" isDisabled={disabled} onClick={() => setAddOpen(true)} />
      <SideNavItem label="Devices" isDisabled={disabled} onClick={() => setDevicesOpen(true)} />
      {addOpen ? (
        <AddProjectDialog remote={remote} connected={!disabled} onClose={() => setAddOpen(false)} />
      ) : null}
      {devicesOpen ? (
        <DevicesDialog view={view} remote={remote} self={device} onClose={() => setDevicesOpen(false)} />
      ) : null}
      {removing === undefined ? null : (
        <RemoveProjectDialog project={removing} remote={remote} connected={!disabled} onClose={() => setRemoving(undefined)} />
      )}
    </>
  );
}

function ConversationNodeItem({
  node,
  depth,
  shown,
  disabled,
  remote,
  onSelect,
}: {
  node: ConversationNode;
  depth: number;
  shown: ConversationId | undefined;
  disabled: boolean;
  remote: RemoteDurable;
  onSelect?: () => void;
}) {
  const { summary } = node;
  // Archive sits beside the item, not in endContent: a <button> inside the item's
  // own <button> is invalid HTML and pollutes the item's accessible name.
  const item = (
    <SideNavItem
      label={summary.title ?? "New conversation"}
      isSelected={summary.id === shown}
      isDisabled={disabled}
      style={depth === 0 ? { flex: 1, minWidth: 0 } : undefined}
      onClick={() => {
        void remote.controller.switchConversation(summary.id);
        onSelect?.();
      }}
    >
      {node.children.length === 0
        ? undefined
        : node.children.map((child) => (
            <ConversationNodeItem
              key={child.summary.id}
              node={child}
              depth={depth + 1}
              shown={shown}
              disabled={disabled}
              remote={remote}
              onSelect={onSelect}
            />
          ))}
    </SideNavItem>
  );
  if (depth > 0) return item;
  return (
    // vAlign="start": the item's height grows with expanded children; the action
    // must sit on the item's own row, not vertically centered over the block.
    // The trigger is a sibling, not endContent: a <button> inside the item's own
    // <button> is invalid HTML and pollutes the item's accessible name.
    <HStack gap={0} vAlign="start">
      {item}
      <DropdownMenu
        hasChevron={false}
        button={{ label: "Conversation actions", children: "⋯", variant: "ghost", size: "sm", isDisabled: disabled }}
        items={[
          {
            label: "Archive",
            onClick: () => void remote.controller.archive(summary.id, true),
          },
        ]}
      />
    </HStack>
  );
}

function AddProjectDialog({ remote, connected, onClose }: { remote: RemoteDurable; connected: boolean; onClose: () => void }) {
  const [path, setPath] = useState("");
  const add = (): void => {
    void remote.controller.addProject(path.trim());
    onClose();
  };
  return (
    <Dialog isOpen onOpenChange={(open) => (open ? undefined : onClose())} purpose="form" width={480}>
      <Layout
        header={
          <DialogHeader
            title="Add project"
            subtitle="A local directory on the host that conversations can work in."
            onOpenChange={() => onClose()}
          />
        }
        content={
          <LayoutContent>
            <TextInput label="Path" value={path} onChange={setPath} />
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} hAlign="end">
              <Button label="Cancel" variant="secondary" onClick={onClose} />
              <Button label="Add project" variant="primary" isDisabled={!connected || path.trim() === ""} onClick={add} />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}

function RemoveProjectDialog({
  project,
  remote,
  connected,
  onClose,
}: {
  project: Project;
  remote: RemoteDurable;
  connected: boolean;
  onClose: () => void;
}) {
  const remove = (): void => {
    void remote.controller.removeProject(project.path);
    onClose();
  };
  return (
    <Dialog isOpen onOpenChange={(open) => (open ? undefined : onClose())} purpose="form" width={480}>
      <Layout
        header={
          <DialogHeader
            title={`Remove project ${project.name}?`}
            subtitle="The directory and its conversations are kept; only the registration is removed."
            onOpenChange={() => onClose()}
          />
        }
        content={<LayoutContent />}
        footer={
          <LayoutFooter>
            <HStack gap={2} hAlign="end">
              <Button label="Cancel" variant="secondary" onClick={onClose} />
              <Button label="Remove project" variant="primary" isDisabled={!connected} onClick={remove} />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}

function DraftComposer({ remote, home, connected }: { remote: RemoteDurable; home: Home; connected: boolean }) {
  const [value, setValue] = useState("");
  // ADR-0010: project conversations default to a fresh worktree; this switch opts out.
  const [direct, setDirect] = useState(false);
  return (
    <VStack gap={1}>
      {home.kind !== "project" ? null : (
        <Switch
          label="Work directly in project directory"
          size="sm"
          value={direct}
          onChange={setDirect}
          isDisabled={!connected}
        />
      )}
      <ChatComposer
        value={value}
        onChange={setValue}
        onSubmit={(text) => {
          void remote.controller.createConversation(home, text, direct ? "project" : undefined);
        }}
        isDisabled={!connected}
        placeholder="The first message creates the conversation…"
      />
    </VStack>
  );
}

function Composer({
  view,
  remote,
  conversation,
  busy,
  narrow,
}: {
  view: DurableView;
  remote: RemoteDurable;
  conversation: NonNullable<DurableView["conversation"]>;
  busy: boolean;
  narrow: boolean;
}) {
  const [value, setValue] = useState("");
  const agent = agentOf(conversation);
  const model = agent.model === undefined ? "No model" : `${agent.model.provider}/${agent.model.modelId}`;
  const status = statusText(conversation);
  const disconnected = view.connection !== "connected";
  const models = view.models.map((candidate) => ({
    label: `${candidate.provider}/${candidate.modelId}`,
    onClick: () => void remote.controller.setModel({ provider: candidate.provider, modelId: candidate.modelId }),
  }));
  return (
    <ChatComposer
      value={value}
      onChange={setValue}
      // Enter prompts when idle and steers when busy.
      onSubmit={(text) => void remote.controller.submit(text, "steer")}
      isStopShown={busy && value.trim() === ""}
      onStop={() => void remote.controller.abort()}
      isDisabled={disconnected}
      placeholder={busy ? "Steer the running turn…" : "Ask the agent…"}
      headerContext={status === "" ? undefined : <Text type="supporting">{status}</Text>}
      footerActions={
        narrow ? (
          <DropdownMenu
            button={{ label: "Controls", variant: "ghost", isDisabled: disconnected }}
            items={[
              { label: `Thinking: ${agent.thinkingLevel ?? "off"}`, onClick: () => void remote.controller.cycleThinking() },
              { label: "Compact", onClick: () => void remote.controller.compact(undefined) },
              { type: "section", title: `Model: ${model}`, items: models },
            ]}
          />
        ) : (
          <>
            <DropdownMenu
              button={{ label: model, variant: "ghost", size: "sm", isDisabled: disconnected }}
              items={models}
            />
            <Button
              label={`Thinking: ${agent.thinkingLevel ?? "off"}`}
              variant="ghost"
              size="sm"
              isDisabled={disconnected}
              onClick={() => void remote.controller.cycleThinking()}
            />
            <Button label="Compact" variant="ghost" size="sm" isDisabled={disconnected} onClick={() => void remote.controller.compact(undefined)} />
          </>
        )
      }
      sendActions={
        <Button
          label="Follow-up"
          variant="ghost"
          size={narrow ? "md" : "sm"}
          tooltip="Queue after the running turn"
          isDisabled={disconnected || value.trim() === ""}
          onClick={() => {
            void remote.controller.submit(value.trim(), "followUp");
            setValue("");
          }}
        />
      }
    />
  );
}

function LiveState({ view, remote }: { view: DurableView; remote: RemoteDurable }) {
  const rows = view.tasks === undefined ? [] : taskRows(view.tasks);
  const queue = view.conversation === undefined ? [] : queueItems(view.conversation);
  const notices = [...view.notices].reverse().slice(0, 5);
  const usage = view.conversation === undefined ? [] : usageRows(view.conversation);
  return (
    <VStack gap={4}>
      {view.docs.map((doc) => (
        <DocumentView key={doc.kind} doc={doc} remote={remote} connected={view.connection === "connected"} />
      ))}
      <List density="compact" header={<Text type="label" weight="semibold">Tasks</Text>}>
        {rows.length === 0 ? (
          <ListItem label="No live tasks" />
        ) : (
          rows.map((row) => <ListItem key={row.id} label={`${"\u00a0\u00a0".repeat(row.depth)}${row.depth > 0 ? "└ " : ""}${row.label}`} />)
        )}
      </List>
      <List density="compact" header={<Text type="label" weight="semibold">Queue</Text>}>
        {queue.length === 0 ? (
          <ListItem label="Empty" />
        ) : (
          queue.map((item) => <ListItem key={item.id} label={item.text} startContent={<Token label={item.mode} size="sm" />} />)
        )}
      </List>
      {notices.length === 0 ? null : (
        <List density="compact" header={<Text type="label" weight="semibold">Notices</Text>}>
          {notices.map((notice) => (
            <ListItem
              key={notice.id}
              label={notice.message}
              startContent={
                <StatusDot variant={notice.level === "error" ? "error" : notice.level === "warning" ? "warning" : "neutral"} label={notice.level} />
              }
            />
          ))}
        </List>
      )}
      {usage.length === 0 ? null : (
        <List density="compact" header={<Text type="label" weight="semibold">Usage</Text>}>
          {usage.map((row) => (
            <ListItem key={row.key} label={row.key} description={`↑${row.input} ↓${row.output} · $${row.cost.toFixed(4)}`} />
          ))}
        </List>
      )}
      <McpSection view={view} />
    </VStack>
  );
}

const MCP_VARIANT = { connecting: "warning", connected: "success", failed: "error", disabled: "neutral" } as const;

/** The host's MCP servers (ADR-0012): per-server state and config errors; hidden when MCP is off. */
function McpSection({ view }: { view: DurableView }) {
  const mcp = view.mcp;
  if (mcp === null || (mcp.servers.length === 0 && mcp.errors.length === 0)) return null;
  return (
    <List density="compact" header={<Text type="label" weight="semibold">MCP</Text>}>
      {mcp.servers.map((server) => (
        <ListItem
          key={server.name}
          label={server.name}
          description={
            server.state === "connected"
              ? `${server.tools} tool${server.tools === 1 ? "" : "s"}${server.error === undefined ? "" : ` · ${server.error}`}`
              : (server.error ?? server.state)
          }
          startContent={<StatusDot variant={MCP_VARIANT[server.state]} label={server.state} isPulsing={server.state === "connecting"} />}
        />
      ))}
      {mcp.errors.map((error, index) => (
        <ListItem key={index} label={error} startContent={<StatusDot variant="error" label="config error" />} />
      ))}
    </List>
  );
}

function DevicesDialog({
  view,
  remote,
  self,
  onClose,
}: {
  view: DurableView;
  remote: RemoteDurable;
  self?: KeyPair;
  onClose: () => void;
}) {
  const connected = view.connection === "connected";
  const selfKey = self === undefined ? undefined : toBase64Url(self.publicKey);
  const [offer, setOffer] = useState<{ url: string; expiresAt: number }>();
  const [pairError, setPairError] = useState<string>();
  const pair = (): void => {
    setPairError(undefined);
    void remote.controller.createPairing().then(setOffer, (error: unknown) => {
      setPairError(error instanceof Error ? error.message : String(error));
    });
  };
  return (
    <Dialog isOpen onOpenChange={(open) => (open ? undefined : onClose())} width={440}>
      <Layout
        header={
          <DialogHeader
            title="Devices"
            subtitle="Paired devices can reach this host over the secure channel."
            onOpenChange={() => onClose()}
          />
        }
        content={
          <LayoutContent>
            <VStack gap={4} padding={2}>
              {view.devices.length === 0 ? (
                <Text type="supporting">No paired devices.</Text>
              ) : (
                <List density="compact">
                  {view.devices.map((device) => (
                    <DeviceRow
                      key={device.publicKey}
                      device={device}
                      isSelf={device.publicKey === selfKey}
                      connected={connected}
                      remote={remote}
                    />
                  ))}
                </List>
              )}
              {pairError === undefined ? null : <Banner status="error" title="Could not create a pairing offer" description={pairError} />}
              {offer === undefined ? (
                <Button label="Pair a device" variant="secondary" isDisabled={!connected} onClick={pair} />
              ) : (
                <PairingOffer url={offer.url} expiresAt={offer.expiresAt} onRenew={pair} />
              )}
            </VStack>
          </LayoutContent>
        }
      />
    </Dialog>
  );
}

function DeviceRow({
  device,
  isSelf,
  connected,
  remote,
}: {
  device: DeviceEntry;
  isSelf: boolean;
  connected: boolean;
  remote: RemoteDurable;
}) {
  return (
    <ListItem
      label={device.name}
      description={`Paired ${new Date(device.pairedAt).toLocaleDateString()}`}
      endContent={
        <HStack gap={2} vAlign="center">
          {isSelf ? <Token label="This device" size="sm" /> : null}
          <Button
            label="Revoke"
            variant="ghost"
            size="sm"
            isDisabled={!connected}
            onClick={() => void remote.controller.revokeDevice(device.publicKey)}
          />
        </HStack>
      }
    />
  );
}

function PairingOffer({ url, expiresAt, onRenew }: { url: string; expiresAt: number; onRenew: () => void }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  if (seconds === 0) {
    return (
      <HStack gap={2} vAlign="center">
        <Text type="supporting">Expired</Text>
        <Button label="New code" variant="secondary" size="sm" onClick={onRenew} />
      </HStack>
    );
  }
  return (
    <VStack gap={3} hAlign="center">
      <QrImage text={url} />
      <Text type="supporting" style={{ wordBreak: "break-all", userSelect: "all" }}>
        {url}
      </Text>
      <Text type="supporting">
        Expires in {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
      </Text>
    </VStack>
  );
}

const QR_QUIET = 2;

function QrImage({ text }: { text: string }) {
  const qr = useMemo(() => encode(text, { border: 0 }), [text]);
  const size = qr.size + QR_QUIET * 2;
  return (
    <svg
      role="img"
      aria-label="Pairing QR code"
      viewBox={`0 0 ${size} ${size}`}
      width={200}
      height={200}
      style={{ display: "block" }}
    >
      {/* Fixed black-on-white: scanners need the contrast regardless of theme. */}
      <rect width={size} height={size} fill="#ffffff" />
      {/* One path, not per-module rects — rect seams anti-alias into a ragged grid that hurts scanning. */}
      <path
        shapeRendering="crispEdges"
        fill="#000000"
        d={qr.data
          .flatMap((row, y) => row.map((dark, x) => (dark ? `M${x + QR_QUIET} ${y + QR_QUIET}h1v1h-1z` : "")))
          .filter((segment) => segment !== "")
          .join("")}
      />
    </svg>
  );
}
