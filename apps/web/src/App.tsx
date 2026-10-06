import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import {
  ChatComposer,
  ChatLayout,
  ChatMessage,
  ChatMessageBubble,
  ChatMessageList,
  ChatSystemMessage,
  ChatToolCalls,
} from "@astryxdesign/core/Chat";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { HStack, Layout, LayoutContent, LayoutFooter, LayoutPanel, VStack } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { Markdown } from "@astryxdesign/core/Markdown";
import { MobileNav } from "@astryxdesign/core/MobileNav";
import { SideNav, SideNavHeading, SideNavItem, SideNavSection } from "@astryxdesign/core/SideNav";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Token } from "@astryxdesign/core/Token";
import type { AgentState, ConversationId } from "@earendil-works/pi-durable";
import { type CSSProperties, type ReactNode, useEffect, useMemo, useState } from "react";
import type { ConversationNode, Home, Project } from "@pinomad/protocol/organization.ts";
import { type ChatItem, chatItems, queueItems, statusText, taskRows, usageRows } from "./presentation/chat.ts";
import { DocumentView } from "./presentation/documents.tsx";
import type { RemoteDurable, RemoteDurableOptions } from "@pinomad/protocol/remote-durable.ts";
import { isBusy } from "@pinomad/protocol/transcript.ts";
import type { DurableView } from "@pinomad/protocol/view.ts";
import { addressFromHash } from "./address.ts";
import { useDurableView, useRemoteDurable } from "./use-remote.ts";

const page: CSSProperties = {
  height: "100dvh",
  width: "100%",
  backgroundColor: "var(--color-background-body)",
  color: "var(--color-text-primary)",
};
const chatColumn: CSSProperties = { flex: 1, minHeight: 0 };

export function App() {
  const address = useMemo(() => addressFromHash(window.location.hash), []);
  if (address === undefined) {
    return (
      <Centered>
        <EmptyState title="No host token" description="Open the link the host printed: http://127.0.0.1:5199/#token=…" />
      </Centered>
    );
  }
  return <Connected address={address} />;
}

export function Centered({ children }: { children: ReactNode }) {
  return (
    <VStack style={page} hAlign="center" vAlign="center" padding={6}>
      {children}
    </VStack>
  );
}

function Connected({ address }: { address: { url: string; token: string } }) {
  return <RemoteWorkbench options={address} connectionKey={`${address.url} ${address.token}`} label={address.url} />;
}

/** Connects with `options` and shows the workbench, or why it cannot. */
export function RemoteWorkbench({ options, connectionKey, label }: { options: RemoteDurableOptions; connectionKey: string; label: string }) {
  const state = useRemoteDurable(options, connectionKey);
  if (state.status === "connecting") {
    return (
      <Centered>
        <EmptyState title="Connecting" description={label} />
      </Centered>
    );
  }
  if (state.status === "failed") {
    return (
      <Centered>
        <Banner status="error" title="Could not connect to the host" description={state.error} />
      </Centered>
    );
  }
  return <Workbench remote={state.remote} />;
}

const agentOf = (conversation: NonNullable<DurableView["conversation"]>): AgentState =>
  (conversation.docs["pi.agent"] ?? {}) as AgentState;

function Workbench({ remote }: { remote: RemoteDurable }) {
  const view = useDurableView(remote);
  // `drafting` starts true: after connect nothing is shown, and the composer
  // creates a conversation at the draft's home instead of prompting it.
  const [drafting, setDrafting] = useState(true);
  const [draft, setDraft] = useState<Home>({ kind: "chat" });
  // The shown conversation's identity decides drafting; creating or selecting one
  // leaves it, archiving the shown one or "New chat" enters it.
  useEffect(() => setDrafting(view.conversation === undefined), [view.conversation?.conversation.id]);
  const conversation = drafting ? undefined : view.conversation;
  const items = useMemo(() => (conversation === undefined ? [] : chatItems(conversation)), [conversation]);
  const busy = conversation !== undefined && isBusy(conversation);
  const home = view.home;
  const homeLabel =
    home === undefined ? undefined : home.kind === "chat" ? "Chat" : projectName(view.organized, home.path);
  const checkout = conversation === undefined ? undefined : agentOf(conversation).cwd;
  const draftLabel = draft.kind === "chat" ? "New chat" : `New conversation in ${projectName(view.organized, draft.path)}`;
  const startDraft = (home: Home): void => {
    setDraft(home);
    setDrafting(true);
  };
  // Below this the chat column would be squeezed; the live state moves into a dialog.
  const narrow = useMediaQuery("(max-width: 1023px)");
  const [navOpen, setNavOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [forkAt, setForkAt] = useState<string>();
  return (
    <VStack style={page}>
      <Layout
        height="fill"
        start={narrow ? undefined : <ConversationNav view={view} remote={remote} onDraft={startDraft} />}
        content={
          <LayoutContent padding={0}>
            <VStack height="100%">
              {narrow ? (
                <HStack padding={2} gap={2} hAlign="between">
                  <Button label="Conversations" variant="ghost" onClick={() => setNavOpen(true)} />
                  <Button label="Live state" variant="ghost" onClick={() => setPanelOpen(true)} />
                </HStack>
              ) : null}
              <ConnectionBanner view={view} />
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
                      <Text type="label" weight="semibold">
                        {homeLabel}
                      </Text>
                      {checkout === undefined ? null : (
                        <Text type="supporting" maxLines={1}>
                          {checkout}
                        </Text>
                      )}
                    </HStack>
                  )}
                  <ChatLayout
                    style={chatColumn}
                    composer={<Composer view={view} remote={remote} conversation={conversation} busy={busy} narrow={narrow} />}
                    emptyState={<EmptyState title="Nothing here yet" description="Ask the agent something. Every client sees it." />}
                  >
                    {items.length === 0 ? null : (
                      <ChatMessageList isStreaming={busy}>
                        {items.map((item) => (
                          <ChatRow key={item.id} item={item} onFork={setForkAt} connected={view.connection === "connected"} />
                        ))}
                      </ChatMessageList>
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
          <ConversationItems view={view} remote={remote} onDraft={startDraft} onSelect={() => setNavOpen(false)} />
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
            subtitle="The fork sees the conversation up to here and runs in its own conversation."
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

function ConnectionBanner({ view }: { view: DurableView }) {
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

function ConversationNav({ view, remote, onDraft }: { view: DurableView; remote: RemoteDurable; onDraft: (home: Home) => void }) {
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
      <ConversationItems view={view} remote={remote} onDraft={onDraft} />
    </SideNav>
  );
}

function ConversationItems({
  view,
  remote,
  onSelect,
  onDraft,
}: {
  view: DurableView;
  remote: RemoteDurable;
  onSelect?: () => void;
  onDraft: (home: Home) => void;
}) {
  const disabled = view.connection !== "connected";
  const [addOpen, setAddOpen] = useState(false);
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
      {addOpen ? (
        <AddProjectDialog remote={remote} connected={!disabled} onClose={() => setAddOpen(false)} />
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
  return (
    <ChatComposer
      value={value}
      onChange={setValue}
      onSubmit={(text) => {
        void remote.controller.createConversation(home, text);
      }}
      isDisabled={!connected}
      placeholder="The first message creates the conversation…"
    />
  );
}

function ChatRow({ item, onFork, connected }: { item: ChatItem; onFork: (entryId: string) => void; connected: boolean }) {
  switch (item.kind) {
    case "user":
      return (
        <ChatMessage sender="user">
          <ChatMessageBubble>{item.text}</ChatMessageBubble>
        </ChatMessage>
      );
    case "assistant": {
      const interrupted = item.stopReason === "aborted";
      // Only a settled answer is an entry a fork can start from.
      const forkable = !item.streaming && !interrupted;
      return (
        <ChatMessage
          sender="assistant"
          metadata={
            interrupted ? (
              <Token label="interrupted" color="orange" size="sm" />
            ) : forkable ? (
              <Button label="Fork" variant="ghost" size="sm" isDisabled={!connected} tooltip="Continue from here in a new conversation" onClick={() => onFork(item.id)} />
            ) : undefined
          }
        >
          {item.thinking === undefined ? null : (
            <Collapsible trigger={<Text type="supporting">{item.streaming && item.text === "" ? "Thinking…" : "Thinking"}</Text>} defaultIsOpen={false}>
              <Markdown density="compact">{item.thinking}</Markdown>
            </Collapsible>
          )}
          {item.text === "" ? null : (
            <ChatMessageBubble variant="ghost">
              <Markdown density="compact" isStreaming={item.streaming}>
                {item.text}
              </Markdown>
            </ChatMessageBubble>
          )}
          {item.tools.length === 0 ? null : (
            <ChatToolCalls
              calls={item.tools.map((tool) => ({
                key: tool.callId,
                name: tool.name,
                status: tool.status,
                ...(tool.conversationId !== undefined
                  ? { target: `subagent ${tool.conversationId}` }
                  : tool.target === undefined
                    ? {}
                    : { target: tool.target }),
                ...(tool.status === "error" && tool.output !== undefined ? { errorMessage: tool.output } : {}),
                ...(tool.status !== "error" && tool.output !== undefined
                  ? { resultDetail: <Markdown density="compact">{`\`\`\`\n${tool.output}\n\`\`\``}</Markdown> }
                  : {}),
              }))}
            />
          )}
        </ChatMessage>
      );
    }
    case "compaction":
      return <ChatSystemMessage variant="divider">Earlier context summarized</ChatSystemMessage>;
    case "reset":
      return <ChatSystemMessage variant="divider">New context</ChatSystemMessage>;
  }
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
    </VStack>
  );
}
