import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Heading } from "@astryxdesign/core/Heading";
import { IconButton } from "@astryxdesign/core/IconButton";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Link } from "@astryxdesign/core/Link";
import { List, ListItem } from "@astryxdesign/core/List";
import { MoreMenu } from "@astryxdesign/core/MoreMenu";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Selector } from "@astryxdesign/core/Selector";
import { SideNav, SideNavItem, SideNavSection } from "@astryxdesign/core/SideNav";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Token } from "@astryxdesign/core/Token";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { agentNameProblem, type AgentRole, type AgentRoleProblem } from "@pinomad/protocol/agents.ts";
import { hostSupportsFeature } from "@pinomad/protocol/frames.ts";
import type { KeyPair } from "@pinomad/protocol/noise.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import { cleanHostName, type HostSettings, type QueueMode } from "@pinomad/protocol/settings.ts";
import type { ModelRef } from "@earendil-works/pi-durable";
import type { DurableView } from "@pinomad/protocol/view.ts";
import { familyUpdatedAt, relativeTime } from "@pinomad/client/family.ts";
import { summaryOf, thinkingLevelLabels } from "@pinomad/client/model.ts";
import { useAccountModel } from "../../entities/account/account-context.tsx";
import { ModelSelector } from "../../entities/model/model-selector.tsx";
import { useNow } from "../../shared/use-now.ts";
import { Archive, ArchiveRestore, ArrowBigUpDash, ArrowLeft, Bot, Cancel, ChatBubble, ChevronRight, Computer, Devices, Info, KeyRound, Laptop, MoreHorizontal, Palette, Puzzle, RefreshCw, Sparkles, UserCircle } from "../../shared/ui/icons.tsx";
import { GROUP_ROWS, SettingsGroup, SettingsRow } from "../../shared/ui/settings-group.tsx";
import { AccountPanel } from "../account/account-panel.tsx";
import { AgentEditorDialog } from "./agent-editor-dialog.tsx";
import { AppearanceSection } from "./appearance-section.tsx";
import type { FrameMachine } from "./app-frame.tsx";
import { DevicesSection } from "./devices-section.tsx";
import { HostUpgradeSection } from "./host-upgrade-section.tsx";
import { HostsSection } from "./hosts.tsx";
import { LocalHostSection } from "./local-host-section.tsx";
import { ProvidersSection } from "./providers-section.tsx";
import { SettingsSubpageContext, type SettingsSubpage } from "./settings-subpage.ts";
import { UpdatesSection } from "./updates-section.tsx";

const SECTIONS = [
  { id: "account", title: "Account", icon: UserCircle, group: "account", keywords: "profile email password sign-in methods github google apple signed-in devices sessions sign out delete" },
  { id: "hosts", title: "Hosts", icon: Computer, group: "device", keywords: "pair unpair add connection relay peer-to-peer join" },
  { id: "this-mac", title: "This Mac", icon: Laptop, group: "device", keywords: "local host install" },
  { id: "updates", title: "Updates", icon: RefreshCw, group: "device", keywords: "version download" },
  { id: "appearance", title: "Appearance", icon: Palette, group: "device", keywords: "theme light dark system color" },
  { id: "providers", title: "Providers", icon: KeyRound, group: "host", keywords: "api key login subscription" },
  { id: "models", title: "Models", icon: Sparkles, group: "host", keywords: "default model thinking" },
  { id: "agents", title: "Agents", icon: Bot, group: "host", keywords: "roles subagents" },
  { id: "mcp", title: "MCP", icon: Puzzle, group: "host", keywords: "servers tools" },
  { id: "chats", title: "Chats", icon: ChatBubble, group: "host", keywords: "conversations history" },
  { id: "devices", title: "Devices", icon: Devices, group: "host", keywords: "paired revoke" },
  { id: "archived", title: "Archived", icon: Archive, group: "host", keywords: "archive restore" },
  { id: "upgrade", title: "Upgrade", icon: ArrowBigUpDash, group: "host", keywords: "update version pinomad" },
  { id: "about", title: "About", icon: Info, group: "host", keywords: "version info" },
] as const;

type Section = (typeof SECTIONS)[number];
export type SectionId = Section["id"];

type AccountSectionId = "account";
const isAccountSection = (id: SectionId): id is AccountSectionId => id === "account";

const sectionTitle = (id: SectionId): string => SECTIONS.find((section) => section.id === id)!.title;

const isHostSection = (id: SectionId): boolean =>
  SECTIONS.find((section) => section.id === id)?.group === "host";

/** A section the search box keeps: its name or what it holds contains the query. */
const matchesQuery = (entry: Section, query: string): boolean => {
  const needle = query.trim().toLowerCase();
  return needle === "" || `${entry.title} ${entry.keywords}`.toLowerCase().includes(needle);
};

const sectionIcon = (Icon: Section["icon"]): ReactNode => (
  <Icon aria-hidden="true" style={{ width: "var(--spacing-4)", height: "var(--spacing-4)" }} />
);

/**
 * Settings in two groups. "This device" belongs to the client — the paired
 * hosts and, on the desktop, its updates and (macOS) the switch over the host
 * installed on this Mac — and works while disconnected.
 * The host group is the connected host's settings and providers
 * (ADR-0021, 0031): everything shown comes from the `settings` / `providers` / `mcp` /
 * devices streams, so a change another device makes appears here the moment
 * the host pushes it.
 *
 * Settings is a page of the app frame, not a dialog over it: on a wide window
 * its section nav takes the sidebar's place and the open section fills the
 * main pane; on a narrow one the pane drills in from a section list. The
 * frame keeps the sidebar and workbench mounted underneath, only hidden.
 */
export interface SettingsRequest {
  /** The section to open on instead of the default (the sidebar's account opens Account). */
  readonly section?: SectionId;
}

export interface SettingsScreen {
  /** The section nav for the sidebar slot; absent when narrow, where the page lists the sections itself. */
  readonly nav: ReactNode | undefined;
  /** The main pane: the open section, or (narrow) the section list. */
  readonly content: ReactNode;
}

/** Escape closes Settings unless it belongs to something open over it (a dialog, menu or listbox). */
const OWNS_ESCAPE = 'dialog, [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [aria-expanded="true"]';
const TEXT_ENTRY = 'textarea, [contenteditable="true"], input:not([type="checkbox"]):not([type="radio"]):not([type="button"])';

export function useSettingsScreen({
  machines,
  request,
  focusKey,
  narrow,
  safeLeft,
  onClose,
}: {
  /** Every paired machine; the host group manages one of them at a time. */
  machines: readonly FrameMachine[];
  /** Open while defined; a new request reopens it on its section, with the search cleared. */
  request: SettingsRequest | undefined;
  /** The machine to open on — the focused one. */
  focusKey: string | undefined;
  narrow: boolean;
  /** Left inset reserved for the macOS traffic lights when the nav owns the window corner. */
  safeLeft?: string;
  onClose: () => void;
}): SettingsScreen | undefined {
  const [opened, setOpened] = useState(request);
  const [section, setSection] = useState<SectionId | undefined>(request?.section);
  const [query, setQuery] = useState("");
  // A page the open section opened inside itself (one host's page).
  const [subpage, setSubpage] = useState<SettingsSubpage>();
  // Picked here, not followed from focus: a form half-filled for one machine
  // must never be saved to another because focus moved underneath it.
  const [pickedKey, setPickedKey] = useState(focusKey);
  if (opened !== request) {
    setOpened(request);
    setSection(request?.section);
    setQuery("");
    setSubpage(undefined);
    setPickedKey(focusKey);
  }
  const subpageHost = useMemo(() => ({ ownsBack: narrow, set: setSubpage }), [narrow]);
  // Opening moves focus to the way out, the page's first control.
  const closeSlot = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (request !== undefined) closeSlot.current?.querySelector("button")?.focus();
  }, [request]);
  const accountStatus = useAccountModel().state.status;
  const open = request !== undefined;

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      // Not `defaultPrevented`: SegmentedControl prevents every Escape, open or not.
      if (event.key !== "Escape") return;
      if (event.target instanceof Element && event.target.closest(OWNS_ESCAPE) !== null) return;
      // A text field keeps its own Escape: closing would throw away what was typed.
      if (event.target instanceof Element && event.target.closest(TEXT_ENTRY) !== null) return;
      onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return undefined;

  const machine = machines.find((entry) => entry.key === pickedKey) ?? machines[0];
  const view = machine?.view;
  const remote = machine?.remote;
  const hostAvailable = view !== undefined && remote !== undefined;
  const connected = view?.connection === "connected";
  const hasUpdater = window.pinomadDesktop?.updates !== undefined;
  const hasLocalHost = window.pinomadDesktop?.localHost !== undefined;
  const choosable = machines.length > 1;
  // A host that is not ready has no settings streams to show; open on the
  // device's own sections then. An explicit pick stays put and explains itself.
  const active = section ?? (connected ? "providers" : "hosts");
  const hostName = view?.settings?.hostName ?? machine?.label ?? "This host";
  // Signed in, the account; signed out, the sign-in form; no group at all
  // where this client can't reach an account API.
  const accountSections =
    accountStatus === "signed-in" || accountStatus === "signed-out" ? SECTIONS.filter((entry) => entry.group === "account") : [];
  const allGroups = [
    ...(accountSections.length === 0 ? [] : [{ title: "Account", sections: accountSections }]),
    {
      title: "This device",
      sections: SECTIONS.filter(
        (entry) =>
          entry.group === "device" && (entry.id !== "updates" || hasUpdater) && (entry.id !== "this-mac" || hasLocalHost),
      ),
    },
    // With a picker the machine's name is on the picker; the title just names the group.
    ...(hostAvailable || choosable
      ? [{ title: choosable ? "Host" : hostName, sections: SECTIONS.filter((entry) => entry.group === "host") }]
      : []),
  ];
  const searching = query.trim() !== "";
  const groups = allGroups
    .map((group) => ({ ...group, sections: group.sections.filter((entry) => matchesQuery(entry, query)) }))
    .filter((group) => group.sections.length > 0);
  // Searching looks for a section, not for another host: the picker waits.
  const picker =
    searching || !choosable || machine === undefined ? null : (
      <Selector
        className="pigui-nav-lead"
        label="Host"
        isLabelHidden
        size="sm"
        variant="ghost"
        placement="below"
        startIcon={<Computer aria-hidden="true" className="size-4 shrink-0 text-muted" />}
        value={machine.key}
        options={machines.map((entry) => ({ value: entry.key, label: entry.label }))}
        onChange={setPickedKey}
      />
    );

  const searchField = (
    <TextInput
      className="pigui-nav-lead"
      label="Search settings"
      isLabelHidden
      placeholder="Search"
      size="sm"
      startIcon="search"
      value={query}
      onChange={setQuery}
      onKeyDown={(event) => {
        const first = groups[0]?.sections[0];
        if (event.key === "Enter" && first !== undefined) setSection(first.id);
      }}
    />
  );
  const noMatch = groups.length === 0 ? <Text type="supporting">No settings match</Text> : null;

  const page = (
    <SettingsSubpageContext.Provider value={subpageHost}>
      <SectionPage
        // Host-scoped pages carry form and navigation state, so a
        // focus switch must remount them instead of handing A's
        // half-filled form to B's remote. Device sections stay put.
        key={isHostSection(active) ? `host:${machine?.key ?? "none"}` : undefined}
        {...(view === undefined ? {} : { view })}
        {...(remote === undefined ? {} : { remote })}
        {...(machine?.device === undefined ? {} : { device: machine.device })}
        {...(machine?.hostKey === undefined ? {} : { hostKey: machine.hostKey })}
        connected={connected}
        {...(machine?.retry === undefined ? {} : { onReconnect: machine.retry })}
        section={active}
        showTitle={!narrow}
        showSupporting={subpage === undefined}
        onSection={setSection}
      />
    </SettingsSubpageContext.Provider>
  );

  if (!narrow) {
    return {
      nav: (
        <SideNav
          className="pigui-settings-nav"
          aria-label="Settings sections"
          resizable={{ defaultWidth: 260, minWidth: 240, maxWidth: 320, autoSaveId: "pinomad-settings-nav" }}
          // The macOS traffic lights own the top band: it stays an empty
          // drag strip and the way back sits below it, over the search.
          {...(safeLeft === undefined ? {} : { header: <div className="pinomad-drag h-6" /> })}
          topContent={
            <VStack gap={2}>
              <span ref={closeSlot} className="contents">
                <Button
                  label="Settings"
                  aria-label="Close settings"
                  variant="ghost"
                  size="sm"
                  icon={<ChevronRight aria-hidden="true" className="size-4 rotate-180" />}
                  onClick={onClose}
                  className="pigui-nav-lead self-start"
                />
              </span>
              {searchField}
            </VStack>
          }
        >
          <VStack gap={3}>
            {noMatch}
            {groups.map((group) => (
              <SideNavSection key={group.title} title={group.title}>
                {group.sections[0]?.group === "host" ? picker : null}
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
      ),
      content: (
        <div className="h-full overflow-y-auto">
          <div className="mx-auto w-full max-w-[46rem] px-6 pt-14 pb-16">{page}</div>
        </div>
      ),
    };
  }

  const sectionList = (
    <VStack gap={4}>
      {searchField}
      {noMatch}
      {groups.map((group) => (
        <VStack key={group.title} gap={1}>
          <Text type="supporting" weight="semibold">
            {group.title}
          </Text>
          {group.sections[0]?.group === "host" ? picker : null}
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

  // Narrow: the header carries the page's title and the way back.
  return {
    nav: undefined,
    content: (
      <div className="flex h-full min-h-0 flex-col">
        <div
          className="pinomad-drag flex h-10 shrink-0 items-center gap-1 px-3"
          style={safeLeft === undefined ? undefined : { paddingLeft: safeLeft }}
        >
          {section === undefined ? null : (
            <IconButton
              label="Back"
              icon={<ArrowLeft className="size-4" />}
              size="sm"
              variant="ghost"
              onClick={() => (subpage === undefined ? setSection(undefined) : subpage.back())}
            />
          )}
          <h1 className="min-w-0 flex-1 truncate px-1 text-sm font-semibold">
            {subpage?.title ?? (section === undefined ? "Settings" : sectionTitle(section))}
          </h1>
          <span ref={closeSlot} className="contents">
            <IconButton
              label="Close settings"
              icon={<Cancel className="size-4" />}
              size="sm"
              variant="ghost"
              onClick={onClose}
            />
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">{section === undefined ? sectionList : page}</div>
      </div>
    ),
  };
}

/**
 * Settings on its own, nav beside the page: for stories and tests that
 * exercise Settings without the app frame around it.
 */
export function SettingsPage({
  machines,
  initialKey,
  initialSection,
  narrow = false,
  onClose,
}: {
  machines: readonly FrameMachine[];
  initialKey?: string;
  initialSection?: SectionId;
  narrow?: boolean;
  onClose: () => void;
}) {
  const [request] = useState<SettingsRequest>(() => (initialSection === undefined ? {} : { section: initialSection }));
  const screen = useSettingsScreen({ machines, request, focusKey: initialKey, narrow, onClose });
  if (screen === undefined) return null;
  return (
    <div className="flex h-dvh bg-background">
      {screen.nav}
      <section aria-label="Settings" className="pigui-pane min-w-0 flex-1">
        {screen.content}
      </section>
    </div>
  );
}

function SectionPage({
  view,
  remote,
  device,
  hostKey,
  connected,
  onReconnect,
  section,
  showTitle,
  showSupporting,
  onSection,
}: {
  view?: DurableView;
  remote?: RemoteDurable;
  device?: KeyPair;
  hostKey?: string;
  connected: boolean;
  onReconnect?: () => void;
  section: SectionId;
  showTitle: boolean;
  /** Off while the section shows a page of its own, which the supporting line doesn't describe. */
  showSupporting: boolean;
  onSection: (section: SectionId) => void;
}) {
  const { title, supporting, body } = isAccountSection(section)
    ? {
        title: sectionTitle(section),
        supporting: undefined,
        body: (
          <AccountPanel page="overview" />
        ),
      }
    : sectionBody(view, remote, device, hostKey, connected, onReconnect, section);
  const headingId = `settings-${section}-heading`;
  return (
    <VStack
      as="section"
      {...(showTitle ? { "aria-labelledby": headingId } : { "aria-label": title })}
      gap={6}
    >
      <VStack gap={1}>
        {showTitle ? <Heading level={2} id={headingId}>{title}</Heading> : null}
        {showSupporting ? supporting : null}
      </VStack>
      {body}
    </VStack>
  );
}

function sectionBody(
  view: DurableView | undefined,
  remote: RemoteDurable | undefined,
  device: KeyPair | undefined,
  hostKey: string | undefined,
  connected: boolean,
  onReconnect: (() => void) | undefined,
  section: Exclude<SectionId, AccountSectionId>,
): { title: string; supporting?: ReactNode; body: ReactNode } {
  if (section === "hosts") {
    return {
      title: "Hosts",
      supporting: <Text as="p" type="supporting">The machines this device can use. It stays connected to every one paired here.</Text>,
      body: <HostsSection />,
    };
  }
  if (section === "updates") {
    return { title: "Updates", body: <UpdatesSection /> };
  }
  if (section === "appearance") {
    return { title: "Appearance", body: <AppearanceSection /> };
  }
  if (section === "this-mac") {
    return {
      title: "This Mac",
      supporting: (
        <Text as="p" type="supporting">
          Run a PiNomad host here so your other devices can use this Mac. It runs on its own: quitting the app doesn't stop it.
        </Text>
      ),
      body: <LocalHostSection />,
    };
  }
  if (view === undefined || remote === undefined) {
    // The picked machine has no settings streams until it connects.
    return {
      title: sectionTitle(section),
      body: <Text as="p" type="supporting">This host isn't connected. Its settings appear once it is.</Text>,
    };
  }
  switch (section) {
    case "devices":
      return {
        title: "Devices",
        supporting: <Text as="p" type="supporting">Paired devices can reach this host over the secure channel.</Text>,
        body: <DevicesSection view={view} remote={remote} self={device} {...(hostKey === undefined ? {} : { hostKey })} />,
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
    case "upgrade":
      return { title: "Upgrade", body: <HostUpgradeSection view={view} remote={remote} /> };
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
    <SettingsGroup>
      <SettingsRow label="Default model">
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
            variant="secondary"
            size="sm"
            isDisabled={!connected}
            onClick={() => void remote.controller.updateSettings({ defaultModel: null, defaultThinkingLevel: null })}
          />
        ) : null}
      </SettingsRow>
    </SettingsGroup>
  );
}

function ChatsSection({ view, remote, connected }: { view: DurableView; remote: RemoteDurable; connected: boolean }) {
  const settings = view.settings;
  if (settings === null) {
    return <Banner status="warning" title="This host is too old for settings" description="Run `pinomad upgrade` on the host." />;
  }
  return (
    <SettingsGroup>
      <div className={GROUP_ROWS}>
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
      </div>
    </SettingsGroup>
  );
}

/** Restore only: an archived conversation is not opened from here, so nothing gets sent to it while hidden. */
function ArchivedSection({ view, remote, connected }: { view: DurableView; remote: RemoteDurable; connected: boolean }) {
  const now = useNow(60_000);
  const archived = view.organized.archived;
  if (archived.length === 0) return <Text as="p" type="supporting">No archived conversations.</Text>;
  return (
    <SettingsGroup>
      <List hasDividers>
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
    </SettingsGroup>
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
        <SettingsGroup>
          <List hasDividers>
            {mcp.servers.map((server) => (
              <ListItem key={server.name} label={server.name} endContent={<Token label={server.state} size="sm" />} />
            ))}
          </List>
        </SettingsGroup>
      )}
    </VStack>
  );
}

function AboutSection({ view, remote, connected }: { view: DurableView; remote: RemoteDurable; connected: boolean }) {
  const host = view.host;
  const settings = view.settings;
  const canRename = settings !== null && hostSupportsFeature(host?.protocol.minor ?? 0, "hostName");
  return (
    <VStack gap={6}>
      {canRename ? (
        <SettingsGroup>
          <div className="p-4">
            <HostNameField settings={settings} remote={remote} connected={connected} />
          </div>
        </SettingsGroup>
      ) : null}
      <SettingsGroup title="Details">
        <List hasDividers>
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
          <ListItem
            label="Website"
            description={
              // `?home` keeps the site on its home page instead of forwarding
              // a marked browser back to the app.
              <Link href="https://pinomad.si/?home" isExternalLink>
                pinomad.si
              </Link>
            }
          />
        </List>
      </SettingsGroup>
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
            variant="secondary"
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
    <SettingsRow label={title}>
      {customized ? (
        <Button label="Use pi's default" variant="secondary" size="sm" isDisabled={disabled} onClick={onReset} />
      ) : null}
      <SegmentedControl
        value={value}
        onChange={(next) => onChange(next as QueueMode)}
        label={title}
        size="sm"
        isDisabled={disabled}
      >
        <SegmentedControlItem value="one-at-a-time" label="One at a time" />
        <SegmentedControlItem value="all" label="All at once" />
      </SegmentedControl>
    </SettingsRow>
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
                { label: "Edit", onClick: onEdit },
                { label: "Delete", onClick: () => setConfirming(true) },
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
            <Button label="Cancel" variant="secondary" size="sm" onClick={() => setConfirming(false)} />
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
              items={[{ label: "Delete", onClick: () => setConfirming(true) }]}
            />
          </HStack>
        )}
      </HStack>
      {confirming ? (
        <VStack gap={2} style={{ marginBlockStart: "var(--spacing-4)" }}>
          <HStack gap={2} vAlign="center">
            <Button label="Delete" variant="destructive" size="sm" isDisabled={!connected} onClick={remove} />
            <Button label="Cancel" variant="secondary" size="sm" onClick={() => setConfirming(false)} />
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
