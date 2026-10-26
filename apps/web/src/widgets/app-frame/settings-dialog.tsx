import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Heading } from "@astryxdesign/core/Heading";
import { IconButton } from "@astryxdesign/core/IconButton";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { HStack, Layout, LayoutContent, LayoutPanel, VStack } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { MoreMenu } from "@astryxdesign/core/MoreMenu";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { SideNav, SideNavItem, SideNavSection } from "@astryxdesign/core/SideNav";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Token } from "@astryxdesign/core/Token";
import { useEffect, useState, type ReactNode } from "react";
import { agentNameProblem, type AgentRole, type AgentRoleProblem } from "@pinomad/protocol/agents.ts";
import { hostSupportsFeature } from "@pinomad/protocol/frames.ts";
import type { KeyPair } from "@pinomad/protocol/noise.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import { cleanHostName, type HostSettings, type QueueMode } from "@pinomad/protocol/settings.ts";
import type { ModelRef } from "@earendil-works/pi-durable";
import type { DurableView } from "@pinomad/protocol/view.ts";
import { familyUpdatedAt, relativeTime } from "@pinomad/client/family.ts";
import { hostLabels } from "@pinomad/client/stored-host.ts";
import { summaryOf, thinkingLevelLabels } from "@pinomad/client/model.ts";
import { useHosts } from "../../entities/host/host-store.ts";
import { ModelSelector } from "../../entities/model/model-selector.tsx";
import { useNow } from "../../shared/use-now.ts";
import { Archive, ArchiveRestore, ArrowLeft, Bot, ChatBubble, ChevronRight, Computer, Devices, Info, KeyRound, MoreHorizontal, Puzzle, RefreshCw, Sparkles } from "../../shared/ui/icons.tsx";
import { AgentEditorDialog } from "./agent-editor-dialog.tsx";
import { DevicesSection } from "./devices-section.tsx";
import { HostsSection } from "./hosts.tsx";
import { ProvidersSection } from "./providers-section.tsx";
import { UpdatesSection } from "./updates-section.tsx";

const SECTIONS = [
  { id: "hosts", title: "Hosts", icon: Computer, group: "device" },
  { id: "updates", title: "Updates", icon: RefreshCw, group: "device" },
  { id: "providers", title: "Providers", icon: KeyRound, group: "host" },
  { id: "models", title: "Models", icon: Sparkles, group: "host" },
  { id: "agents", title: "Agents", icon: Bot, group: "host" },
  { id: "mcp", title: "MCP", icon: Puzzle, group: "host" },
  { id: "chats", title: "Chats", icon: ChatBubble, group: "host" },
  { id: "devices", title: "Devices", icon: Devices, group: "host" },
  { id: "archived", title: "Archived", icon: Archive, group: "host" },
  { id: "about", title: "About", icon: Info, group: "host" },
] as const;

type Section = (typeof SECTIONS)[number];
type SectionId = Section["id"];

const sectionTitle = (id: SectionId): string => SECTIONS.find((section) => section.id === id)!.title;

const sectionIcon = (Icon: Section["icon"]): ReactNode => (
  <Icon aria-hidden="true" style={{ width: "var(--spacing-4)", height: "var(--spacing-4)" }} />
);

/**
 * Settings in two groups. "This device" belongs to the client — the paired
 * hosts and, on the desktop, its updates — and works while disconnected.
 * The host group is the connected host's settings and providers
 * (ADR-0021, 0031): everything shown comes from the `settings` / `providers` / `mcp` /
 * devices streams, so a change another device makes appears here the moment
 * the host pushes it. A left section nav on wide screens, an iOS-style
 * drill-in under 640px; the open section is the only local state.
 */
export function SettingsDialog({
  view,
  remote,
  device,
  hostKey,
  onClose,
}: {
  view: DurableView;
  remote: RemoteDurable;
  /** This client's device key, for marking "This device" under Devices. */
  device?: KeyPair;
  /** The stored host this connection is to — absent for token clients. */
  hostKey?: string;
  onClose: () => void;
}) {
  const compact = useMediaQuery("(max-width: 640px)");
  const [section, setSection] = useState<SectionId | undefined>(undefined);
  const connected = view.connection === "connected";
  const { hosts } = useHosts();
  const hasUpdater = window.pinomadDesktop?.updates !== undefined;
  // Disconnected, the host group has nothing live to show; land on the
  // device's own hosts instead.
  const active = section ?? (connected ? "providers" : "hosts");
  // The cached name of the host this connection reaches — a token client
  // reaches none of the stored ones, whichever pairing is selected.
  const stored = hosts.find((host) => host.hostKey === hostKey);
  const hostName =
    view.settings?.hostName ?? (stored === undefined ? undefined : hostLabels(hosts).get(stored.hostKey)) ?? "This host";
  const groups = [
    { title: "This device", sections: SECTIONS.filter((entry) => entry.group === "device" && (entry.id !== "updates" || hasUpdater)) },
    { title: hostName, sections: SECTIONS.filter((entry) => entry.group === "host") },
  ];

  const sectionNav = (
    <LayoutPanel padding={2} width="calc(var(--spacing-10) * 7)" hasDivider>
      <SideNav aria-label="Settings sections" style={{ width: "100%" }}>
        <VStack gap={3}>
          {groups.map((group) => (
            <SideNavSection key={group.title} title={group.title}>
              {group.sections.map((entry) => (
                <SideNavItem
                  key={entry.id}
                  label={entry.title}
                  icon={sectionIcon(entry.icon)}
                  isSelected={entry.id === active}
                  onClick={() => setSection(entry.id)}
                />
              ))}
            </SideNavSection>
          ))}
        </VStack>
      </SideNav>
    </LayoutPanel>
  );

  const sectionList = (
    <VStack gap={4}>
      {groups.map((group) => (
        <VStack key={group.title} gap={1}>
          <Text type="supporting" weight="semibold">
            {group.title}
          </Text>
          <List density="compact" aria-label={group.title}>
            {group.sections.map((entry) => (
              <ListItem
                key={entry.id}
                label={entry.title}
                startContent={sectionIcon(entry.icon)}
                endContent={
                  <ChevronRight aria-hidden="true" style={{ width: "var(--spacing-4)", height: "var(--spacing-4)" }} />
                }
                onClick={() => setSection(entry.id)}
              />
            ))}
          </List>
        </VStack>
      ))}
    </VStack>
  );

  return (
    <Dialog
      aria-label="Settings"
      isOpen
      onOpenChange={(open) => (open ? undefined : onClose())}
      purpose="form"
      width="calc(var(--spacing-10) * 22)"
      maxHeight="90dvh"
      variant={compact ? "fullscreen" : "standard"}
      padding={4}
    >
      <Layout
        padding={4}
        style={{ height: compact ? "100dvh" : "min(85dvh, calc(var(--spacing-10) * 17))" }}
        header={
          <DialogHeader
            title={compact && section !== undefined ? sectionTitle(section) : "Settings"}
            startContent={
              compact && section !== undefined ? (
                <IconButton
                  label="Back"
                  icon={<ArrowLeft />}
                  variant="ghost"
                  // DialogHeader pulls its end slot (the close X) up by spacing-2
                  // to center on the title; the start slot needs the same lift.
                  style={{ marginBlock: "calc(-1 * var(--spacing-2))" }}
                  onClick={() => setSection(undefined)}
                />
              ) : undefined
            }
            onOpenChange={() => onClose()}
            hasDivider
          />
        }
        start={compact ? undefined : sectionNav}
        content={
          <LayoutContent padding={compact ? 4 : 6}>
            {compact && section === undefined ? (
              sectionList
            ) : (
              <SectionPage view={view} remote={remote} device={device} hostKey={hostKey} connected={connected} section={active} showTitle={!compact} />
            )}
          </LayoutContent>
        }
      />
    </Dialog>
  );
}

function SectionPage({
  view,
  remote,
  device,
  hostKey,
  connected,
  section,
  showTitle,
}: {
  view: DurableView;
  remote: RemoteDurable;
  device?: KeyPair;
  hostKey?: string;
  connected: boolean;
  section: SectionId;
  showTitle: boolean;
}) {
  const { title, supporting, body } = sectionBody(view, remote, device, hostKey, connected, section);
  const headingId = `settings-${section}-heading`;
  return (
    <VStack
      as="section"
      {...(showTitle ? { "aria-labelledby": headingId } : { "aria-label": title })}
      gap={3}
    >
      <VStack gap={2}>
        {showTitle ? <Heading level={2} id={headingId}>{title}</Heading> : null}
        {supporting}
      </VStack>
      {body}
    </VStack>
  );
}

function sectionBody(
  view: DurableView,
  remote: RemoteDurable,
  device: KeyPair | undefined,
  hostKey: string | undefined,
  connected: boolean,
  section: SectionId,
): { title: string; supporting?: ReactNode; body: ReactNode } {
  switch (section) {
    case "hosts":
      return {
        title: "Hosts",
        supporting: <Text as="p" type="supporting">The hosts this device has paired with. It connects to one at a time.</Text>,
        body: (
          <HostsSection
            connection={view.connection}
            connectedHostKey={hostKey}
            remote={remote}
            hostMinor={view.host?.protocol.minor}
          />
        ),
      };
    case "updates":
      return { title: "Updates", body: <UpdatesSection /> };
    case "devices":
      return {
        title: "Devices",
        supporting: <Text as="p" type="supporting">Paired devices can reach this host over the secure channel.</Text>,
        body: <DevicesSection view={view} remote={remote} self={device} />,
      };
    case "providers":
      return {
        title: "Providers",
        supporting: (
          <Text as="p" type="supporting">
            Credentials are stored on the host in{" "}
            <span style={{ wordBreak: "break-all", userSelect: "all" }}>{view.session.directory}/auth.json</span> and
            shared by every paired device.
          </Text>
        ),
        body: <ProvidersSection view={view} remote={remote} />,
      };
    case "models":
      return {
        title: "Models",
        supporting: <Text as="p" type="supporting">Used when a new conversation doesn't pick its own model.</Text>,
        body: <ModelsSection view={view} remote={remote} connected={connected} />,
      };
    case "agents":
      return {
        title: "Agents",
        supporting: (
          <Text as="p" type="supporting">
            Named agents the model can delegate to with <code>subagent</code> — mention one with <code>@name</code>.{" "}
            Each is a Markdown file in{" "}
            <span style={{ wordBreak: "break-all", userSelect: "all" }}>{view.session.directory}/agents/</span>; edits
            to those files apply immediately.
          </Text>
        ),
        body: <AgentsSection view={view} remote={remote} connected={connected} />,
      };
    case "mcp":
      return { title: "MCP", body: <McpSection view={view} /> };
    case "chats":
      return {
        title: "Chats",
        supporting: (
          <Text as="p" type="supporting">
            How queued messages are delivered when the agent reaches the next turn.
          </Text>
        ),
        body: <ChatsSection view={view} remote={remote} connected={connected} />,
      };
    case "archived":
      return {
        title: "Archived",
        supporting: (
          <Text as="p" type="supporting">
            Archived conversations are hidden from the sidebar. Restoring one brings it back with its forks and
            subagents; a worktree removed on archive is checked out again from its branch.
          </Text>
        ),
        body: <ArchivedSection view={view} remote={remote} connected={connected} />,
      };
    case "about":
      return { title: "About", body: <AboutSection view={view} remote={remote} connected={connected} /> };
  }
}

function ModelsSection({ view, remote, connected }: { view: DurableView; remote: RemoteDurable; connected: boolean }) {
  const settings = view.settings;
  if (settings === null) {
    return <Banner status="warning" title="This host is too old for settings" description="Run `pinomad upgrade` on the host." />;
  }
  return (
    <HStack gap={2} vAlign="center" wrap="wrap">
      <ModelSelector
        models={view.models}
        selected={{
          model: settings.defaultModel ?? undefined,
          level: settings.defaultThinkingLevel ?? "off",
        }}
        isDisabled={!connected}
        onModelChange={(model) => void remote.controller.updateSettings({ defaultModel: model })}
        onLevelChange={(level) => void remote.controller.updateSettings({ defaultThinkingLevel: level })}
      />
      {settings.custom.includes("defaultModel") || settings.custom.includes("defaultThinkingLevel") ? (
        <Button
          label="Use pi's defaults"
          variant="ghost"
          size="sm"
          isDisabled={!connected}
          onClick={() => void remote.controller.updateSettings({ defaultModel: null, defaultThinkingLevel: null })}
        />
      ) : null}
    </HStack>
  );
}

function ChatsSection({ view, remote, connected }: { view: DurableView; remote: RemoteDurable; connected: boolean }) {
  const settings = view.settings;
  if (settings === null) {
    return <Banner status="warning" title="This host is too old for settings" description="Run `pinomad upgrade` on the host." />;
  }
  return (
    <VStack gap={4}>
      <ModeSetting
        title="Steer messages"
        value={settings.steeringMode}
        customized={settings.custom.includes("steeringMode")}
        disabled={!connected}
        onChange={(mode) => void remote.controller.updateSettings({ steeringMode: mode })}
        onReset={() => void remote.controller.updateSettings({ steeringMode: null })}
      />
      <ModeSetting
        title="Follow-up messages"
        value={settings.followUpMode}
        customized={settings.custom.includes("followUpMode")}
        disabled={!connected}
        onChange={(mode) => void remote.controller.updateSettings({ followUpMode: mode })}
        onReset={() => void remote.controller.updateSettings({ followUpMode: null })}
      />
    </VStack>
  );
}

/** Restore only: an archived conversation is not opened from here, so nothing gets sent to it while hidden. */
function ArchivedSection({ view, remote, connected }: { view: DurableView; remote: RemoteDurable; connected: boolean }) {
  const now = useNow(60_000);
  const archived = view.organized.archived;
  if (archived.length === 0) return <Text as="p" type="supporting">No archived conversations.</Text>;
  return (
    <List density="compact">
      {archived.map(({ node, project }) => {
        const title = node.summary.title ?? "New conversation";
        const updatedAt = familyUpdatedAt(node);
        return (
          <ListItem
            key={node.summary.id}
            label={title}
            description={[project?.name ?? "Chat", updatedAt === undefined ? undefined : relativeTime(updatedAt, now)]
              .filter((part) => part !== undefined)
              .join(" · ")}
            endContent={
              <Button
                label={`Restore ${title}`}
                icon={<ArchiveRestore aria-hidden="true" />}
                variant="secondary"
                size="sm"
                isDisabled={!connected}
                onClick={() => void remote.controller.archive(node.summary.id, false)}
              >
                Restore
              </Button>
            }
          />
        );
      })}
    </List>
  );
}

function McpSection({ view }: { view: DurableView }) {
  const mcp = view.mcp;
  if (mcp === null) return <Text as="p" type="supporting">Loading…</Text>;
  return (
    <VStack gap={3}>
      <Text as="p" type="supporting" style={{ userSelect: "all" }}>
        {mcp.configPath}
      </Text>
      {mcp.servers.length === 0 ? (
        <Text as="p" type="supporting">No servers configured.</Text>
      ) : (
        <List density="compact">
          {mcp.servers.map((server) => (
            <ListItem
              key={server.name}
              label={server.name}
              endContent={<Token label={server.state} size="sm" />}
            />
          ))}
        </List>
      )}
    </VStack>
  );
}

function AboutSection({ view, remote, connected }: { view: DurableView; remote: RemoteDurable; connected: boolean }) {
  const host = view.host;
  const settings = view.settings;
  const canRename = settings !== null && hostSupportsFeature(host?.protocol.minor ?? 0, "hostName");
  return (
    <VStack gap={3}>
      {canRename ? <HostNameField settings={settings} remote={remote} connected={connected} /> : null}
      <List density="compact">
        <ListItem label="Host version" description={host?.version ?? "Source checkout"} />
        <ListItem
          label="Protocol"
          description={host === undefined ? "—" : `${host.protocol.major}.${host.protocol.minor}`}
        />
        <ListItem
          label="Data directory"
          description={<span style={{ wordBreak: "break-all", userSelect: "all" }}>{view.session.directory}</span>}
        />
        <ListItem
          label="Settings file"
          description={
            <span style={{ wordBreak: "break-all", userSelect: "all" }}>{view.session.directory}/settings.json</span>
          }
        />
      </List>
      <Text as="p" type="supporting">Edit the settings file by hand only while the host is stopped.</Text>
    </VStack>
  );
}

/**
 * The machine's display name (5.12): what paired devices label this host by.
 * The effective value comes from the settings stream, so a rename by another
 * device resyncs the draft; `null` resets it to the hostname.
 */
function HostNameField({ settings, remote, connected }: { settings: HostSettings; remote: RemoteDurable; connected: boolean }) {
  const current = settings.hostName ?? "";
  const [draft, setDraft] = useState(current);
  useEffect(() => setDraft(current), [current]);
  const cleaned = cleanHostName(draft);
  const canSave = connected && cleaned !== "" && cleaned !== current;
  const save = (): void => void remote.controller.updateSettings({ hostName: cleaned });
  return (
    <VStack gap={1}>
      <TextInput
        label="Host name"
        value={draft}
        onChange={setDraft}
        onEnter={canSave ? save : undefined}
        isDisabled={!connected}
        description="How paired devices name this machine. Without a custom name the hostname is used."
        status={
          draft !== "" && cleaned === ""
            ? { type: "error", message: "The name needs at least one displayable character" }
            : undefined
        }
        width="100%"
      />
      <HStack gap={2} hAlign="end">
        {settings.custom.includes("hostName") ? (
          <Button
            label="Use machine name"
            variant="ghost"
            size="sm"
            isDisabled={!connected}
            onClick={() => void remote.controller.updateSettings({ hostName: null })}
          />
        ) : null}
        <Button label="Save" variant="secondary" size="sm" isDisabled={!canSave} onClick={save} />
      </HStack>
    </VStack>
  );
}

function ModeSetting({
  title,
  value,
  customized,
  disabled,
  onChange,
  onReset,
}: {
  title: string;
  value: QueueMode;
  customized: boolean;
  disabled: boolean;
  onChange: (mode: QueueMode) => void;
  onReset: () => void;
}) {
  return (
    <VStack gap={1}>
      <Text>{title}</Text>
      <HStack gap={2} vAlign="center" wrap="wrap">
        <SegmentedControl
          className="shrink-0"
          value={value}
          onChange={(next) => onChange(next as QueueMode)}
          label={title}
          size="sm"
          isDisabled={disabled}
        >
          <SegmentedControlItem value="one-at-a-time" label="One at a time" />
          <SegmentedControlItem value="all" label="All at once" />
        </SegmentedControl>
        {customized ? (
          <Button label="Use pi's default" variant="ghost" size="sm" isDisabled={disabled} onClick={onReset} />
        ) : null}
      </HStack>
    </VStack>
  );
}

/**
 * Named agents (ADR-0023): the roles and file problems come from the `agents`
 * stream, so a hand-edited file or another device's change appears live; the
 * editor dialog is the only local state.
 */
function AgentsSection({ view, remote, connected }: { view: DurableView; remote: RemoteDurable; connected: boolean }) {
  const agents = view.agents;
  const [editor, setEditor] = useState<{ mode: "create" } | { mode: "edit"; role: AgentRole } | undefined>(undefined);
  if (agents === null) {
    return (
      <Banner
        status="warning"
        title="This host is too old for named agents"
        description="Run `pinomad upgrade` on the host."
      />
    );
  }
  return (
    <VStack gap={3}>
      <HStack gap={2} vAlign="center">
        <Button
          label="New agent"
          variant="secondary"
          size="sm"
          isDisabled={!connected}
          onClick={() => setEditor({ mode: "create" })}
        />
      </HStack>
      {agents.roles.length === 0 && agents.problems.length === 0 ? (
        <Text as="p" type="supporting">No named agents yet.</Text>
      ) : null}
      {agents.roles.map((role) => (
        <AgentRoleCard
          key={role.name}
          role={role}
          view={view}
          remote={remote}
          connected={connected}
          onEdit={() => setEditor({ mode: "edit", role })}
        />
      ))}
      {agents.problems.map((problem) => (
        <AgentProblemCard key={problem.file} problem={problem} remote={remote} connected={connected} />
      ))}
      {editor === undefined ? null : (
        <AgentEditorDialog
          view={view}
          remote={remote}
          connected={connected}
          {...(editor.mode === "edit" ? { role: editor.role } : {})}
          onClose={() => setEditor(undefined)}
        />
      )}
    </VStack>
  );
}

/** `provider/modelId` split on the first `/`; the role file format pins this shape. */
const refOfRoleModel = (model: string): ModelRef => {
  const slash = model.indexOf("/");
  return { provider: model.slice(0, slash), modelId: model.slice(slash + 1) };
};

function AgentRoleCard({
  role,
  view,
  remote,
  connected,
  onEdit,
}: {
  role: AgentRole;
  view: DurableView;
  remote: RemoteDurable;
  connected: boolean;
  onEdit: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const modelSummary = role.model === undefined ? undefined : summaryOf(view.models, refOfRoleModel(role.model));
  const remove = (): void => {
    void remote.controller.deleteAgent(role.name).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason));
    });
  };
  return (
    <Card padding={4}>
      <HStack gap={3} vAlign="start">
        <VStack gap={1} style={{ flex: 1, minInlineSize: 0 }}>
          <Heading level={3}>{role.name}</Heading>
          <Text as="p" type="supporting">{role.description}</Text>
          {role.model === undefined && role.thinkingLevel === undefined ? null : (
            <HStack gap={1} wrap="wrap">
              {role.model === undefined ? null : (
                <Token label={modelSummary?.name ?? role.model} size="sm" />
              )}
              {role.thinkingLevel === undefined ? null : (
                <Token label={thinkingLevelLabels[role.thinkingLevel]} size="sm" />
              )}
              {role.model !== undefined && modelSummary === undefined ? (
                <Token label="Model not available" color="orange" size="sm" />
              ) : null}
            </HStack>
          )}
        </VStack>
        {confirming ? null : (
          <HStack gap={1} vAlign="center">
            <MoreMenu
              icon={<MoreHorizontal aria-hidden="true" />}
              label={`${role.name} actions`}
              size="sm"
              variant="ghost"
              isDisabled={!connected}
              items={[
                { label: "Edit…", onClick: onEdit },
                { label: "Delete…", onClick: () => setConfirming(true) },
              ]}
            />
          </HStack>
        )}
      </HStack>
      {confirming ? (
        <VStack gap={2} style={{ marginBlockStart: "var(--spacing-4)" }}>
          <Text as="p" type="supporting">Conversations already using this agent keep their copy.</Text>
          <HStack gap={2} vAlign="center">
            <Button label="Delete" variant="destructive" size="sm" isDisabled={!connected} onClick={remove} />
            <Button label="Cancel" variant="ghost" size="sm" onClick={() => setConfirming(false)} />
          </HStack>
        </VStack>
      ) : null}
      {error === undefined ? null : (
        <Text type="supporting" role="alert" style={{ color: "var(--danger)" }}>
          {error}
        </Text>
      )}
    </Card>
  );
}

/**
 * A file the loader could not use. A stem that still passes the name rule gets
 * a Delete so the mistake is removable here; anything else is a hand fix.
 */
function AgentProblemCard({
  problem,
  remote,
  connected,
}: {
  problem: AgentRoleProblem;
  remote: RemoteDurable;
  connected: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const deletable = agentNameProblem(problem.file.slice(0, -".md".length)) === undefined;
  const remove = (): void => {
    void remote.controller.deleteAgent(problem.file.slice(0, -".md".length)).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason));
    });
  };
  return (
    <Card padding={4}>
      <HStack gap={3} vAlign="start">
        <VStack gap={1} style={{ flex: 1, minInlineSize: 0 }}>
          <Heading level={3}>{problem.file}</Heading>
          <HStack gap={1} wrap="wrap">
            <Token label="Not loaded" color="orange" size="sm" />
          </HStack>
          <Text as="p" type="supporting">{problem.reason}</Text>
          <Text as="p" type="supporting">Fix this file on the host.</Text>
        </VStack>
        {confirming || !deletable ? null : (
          <HStack gap={1} vAlign="center">
            <MoreMenu
              icon={<MoreHorizontal aria-hidden="true" />}
              label={`${problem.file} actions`}
              size="sm"
              variant="ghost"
              isDisabled={!connected}
              items={[{ label: "Delete…", onClick: () => setConfirming(true) }]}
            />
          </HStack>
        )}
      </HStack>
      {confirming ? (
        <VStack gap={2} style={{ marginBlockStart: "var(--spacing-4)" }}>
          <HStack gap={2} vAlign="center">
            <Button label="Delete" variant="destructive" size="sm" isDisabled={!connected} onClick={remove} />
            <Button label="Cancel" variant="ghost" size="sm" onClick={() => setConfirming(false)} />
          </HStack>
        </VStack>
      ) : null}
      {error === undefined ? null : (
        <Text type="supporting" role="alert" style={{ color: "var(--danger)" }}>
          {error}
        </Text>
      )}
    </Card>
  );
}
