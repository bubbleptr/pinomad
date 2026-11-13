import { Button } from "../../shared/ui/button.tsx";
import { Card, CardContent } from "../../shared/ui/card.tsx";
import { IconButton } from "../../shared/ui/icon-button.tsx";
import { Link } from "../../shared/ui/link.tsx";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from "../../shared/ui/item.tsx";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../../shared/ui/dropdown-menu.tsx";
import { SegmentedControl, SegmentedControlItem } from "../../shared/ui/segmented-control.tsx";
import {
  Combobox,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
  ComboboxTrigger,
  ComboboxValue,
} from "../../shared/ui/combobox.tsx";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue, selectTriggerClassName } from "../../shared/ui/select.tsx";
import { SideNav, SideNavItem, SideNavSection } from "../../shared/ui/side-nav.tsx";
import { Field, FieldError, FieldLabel, FormError } from "../../shared/ui/field.tsx";
import { Input } from "../../shared/ui/input.tsx";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../../shared/ui/input-group.tsx";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { agentNameProblem, type AgentRole, type AgentRoleProblem } from "@pinomad/protocol/agents.ts";
import { hostSupportsFeature } from "@pinomad/protocol/frames.ts";
import type { KeyPair } from "@pinomad/protocol/noise.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import { cleanHostName, type HostSettings, type QueueMode } from "@pinomad/protocol/settings.ts";
import type { ModelRef } from "@earendil-works/pi-durable";
import type { DurableView, ModelSummary, ThinkingLevel } from "@pinomad/protocol/view.ts";
import { familyUpdatedAt, relativeTime } from "@pinomad/client/family.ts";
import { sameModel, summaryOf, thinkingLevelLabels } from "@pinomad/client/model.ts";
import { useAccountModel } from "../../entities/account/account-context.tsx";
import { ModelLogo } from "../../entities/model/model-logo.tsx";
import { useNow } from "../../shared/use-now.ts";
import { ArchiveRestore, ArrowLeft, Bot, Cancel, ChatBubble, ChevronRight, Computer, Devices, Info, KeyRound, MoreHorizontal, Search, SlidersHorizontal, Sparkles, UserCircle } from "../../shared/ui/icons.tsx";
import { GROUP_ROWS, SettingsGroup, SettingsRow } from "../../shared/ui/settings-group.tsx";
import { AccountPanel } from "../account/account-panel.tsx";
import { AgentEditorDialog } from "./agent-editor-dialog.tsx";
import { AppearanceSection } from "./appearance-section.tsx";
import type { FrameMachine } from "./app-frame.tsx";
import { DevicesSection } from "./devices-section.tsx";
import { HostUpgradeSection } from "./host-upgrade-section.tsx";
import { HostStatusDot, HostsSection } from "./hosts.tsx";
import { LocalHostSection } from "./local-host-section.tsx";
import { ProvidersSection } from "./providers-section.tsx";
import { SettingsSubpageContext, type SettingsSubpage } from "./settings-subpage.ts";
import { UpdatesSection } from "./updates-section.tsx";
import { Alert, AlertDescription, AlertTitle } from "../../shared/ui/alert.tsx";
import { Badge } from "../../shared/ui/badge.tsx";

// Grouped by what the user wants to change, not by where it is stored: each
// section's keywords name the sections it absorbed, so search still finds them.
const SECTIONS = [
  { id: "account", title: "Account", icon: UserCircle, group: "account", keywords: "profile email password sign-in methods github google apple signed-in devices sessions sign out delete" },
  { id: "general", title: "General", icon: SlidersHorizontal, group: "device", keywords: "appearance theme light dark system color updates app version download" },
  { id: "hosts", title: "Hosts", icon: Computer, group: "device", keywords: "pair unpair add connection relay peer-to-peer join this mac local host install run" },
  { id: "providers", title: "Providers", icon: KeyRound, group: "host", keywords: "api key login subscription custom endpoint" },
  { id: "models", title: "Models", icon: Sparkles, group: "host", keywords: "default model thinking" },
  { id: "agents", title: "Agents", icon: Bot, group: "host", keywords: "roles subagents named agents mcp servers tools" },
  { id: "chats", title: "Chats", icon: ChatBubble, group: "host", keywords: "conversations queue steer follow-up messages archived archive restore history" },
  { id: "devices", title: "Devices", icon: Devices, group: "host", keywords: "paired revoke" },
  { id: "about", title: "About", icon: Info, group: "host", keywords: "host name rename version upgrade update automatic protocol website" },
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
 * Settings in two groups. "This device" belongs to the client — its look and
 * (desktop) updates, the paired hosts and (macOS) the switch over the host
 * installed on this Mac — and works while disconnected.
 * The host group is one host's settings and providers (ADR-0021, 0031),
 * picked on the page itself: everything shown comes from the `settings` /
 * `providers` / `mcp` / devices streams, so a change another device makes
 * appears here the moment the host pushes it.
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
    { title: "This device", sections: SECTIONS.filter((entry) => entry.group === "device") },
    ...(hostAvailable || choosable
      ? [{ title: "Host settings", sections: SECTIONS.filter((entry) => entry.group === "host") }]
      : []),
  ];
  const groups = allGroups
    .map((group) => ({ ...group, sections: group.sections.filter((entry) => matchesQuery(entry, query)) }))
    .filter((group) => group.sections.length > 0);
  // Which host a host page manages, over its title: a choice with several,
  // the name with one.
  const hostLine = !isHostSection(active) || machine === undefined ? null : choosable ? (
    <Select
      items={machines.map((entry) => ({ value: entry.key, label: entry.label }))}
      value={machine.key}
      onValueChange={(key: string | null) => {
        if (key !== null) setPickedKey(key);
      }}
    >
      <SelectTrigger aria-label="Host" variant="ghost" size="sm" className="-ms-2 self-start">
        <HostStatusDot connected={connected} />
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {machines.map((entry) => (
            <SelectItem key={entry.key} value={entry.key}>
              <HostStatusDot connected={entry.view?.connection === "connected"} />
              {entry.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  ) : (
    <div className="flex items-center gap-2">
      <HostStatusDot connected={connected} />
      <span className="text-xs/5 text-muted-foreground">{hostName}</span>
    </div>
  );

  const searchField = (
    <Field>
      <FieldLabel className="sr-only">Search settings</FieldLabel>
      <InputGroup className="pigui-nav-lead h-7">
        <InputGroupAddon className="pr-0.5 pl-0">
          <Search aria-hidden="true" />
        </InputGroupAddon>
        <InputGroupInput
          placeholder="Search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            const first = groups[0]?.sections[0];
            if (event.key === "Enter" && first !== undefined) setSection(first.id);
          }}
        />
      </InputGroup>
    </Field>
  );
  const noMatch = groups.length === 0 ? <span className="text-xs/5 text-muted-foreground">No settings match</span> : null;

  const page = (
    <SettingsSubpageContext.Provider value={subpageHost}>
      {/* Outside the keyed page: switching hosts remounts the page, not the picker that switched. */}
      <div className="flex flex-col gap-2">
        {hostLine}
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
          hasUpdater={hasUpdater}
          hasLocalHost={hasLocalHost}
          showTitle={!narrow}
          showSupporting={subpage === undefined}
          onSection={setSection}
        />
      </div>
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
            <div className="flex flex-col gap-2">
              <span ref={closeSlot} className="contents">
                <Button
                  aria-label="Close settings"
                  variant="ghost"
                  size="sm"
                  onClick={onClose}
                  className="pigui-nav-lead self-start"
                >
                  <ChevronRight aria-hidden="true" className="size-4 rotate-180" />
                  Settings
                </Button>
              </span>
              {searchField}
            </div>
          }
        >
          <div className="flex flex-col gap-3">
            {noMatch}
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
          </div>
        </SideNav>
      ),
      content: (
        <div className="pigui-settings h-full overflow-y-auto">
          <div className="mx-auto w-full max-w-[46rem] px-6 pt-14 pb-16">{page}</div>
        </div>
      ),
    };
  }

  const sectionList = (
    <div className="flex flex-col gap-4">
      {searchField}
      {noMatch}
      {groups.map((group) => (
        <div className="flex flex-col gap-1" key={group.title}>
          <span className="text-xs/5 font-semibold text-muted-foreground">
            {group.title}
          </span>
          <ItemGroup aria-label={group.title}>
            {group.sections.map((entry) => (
              <Item key={entry.id} size="sm" render={<li />}>
                <ItemMedia>{sectionIcon(entry.icon)}</ItemMedia>
                <ItemContent render={<button type="button" onClick={() => setSection(entry.id)} />}>
                  <ItemTitle>{entry.title}</ItemTitle>
                </ItemContent>
                <ItemActions>
                  <ChevronRight aria-hidden="true" style={{ width: "var(--spacing-4)", height: "var(--spacing-4)" }} />
                </ItemActions>
              </Item>
            ))}
          </ItemGroup>
        </div>
      ))}
    </div>
  );

  // Narrow: the header carries the page's title and the way back.
  return {
    nav: undefined,
    content: (
      <div className="pigui-settings flex h-full min-h-0 flex-col">
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
    <div className="flex h-dvh bg-sidebar">
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
  hasUpdater,
  hasLocalHost,
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
  hasUpdater: boolean;
  hasLocalHost: boolean;
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
    : sectionBody(view, remote, device, hostKey, connected, onReconnect, section, { hasUpdater, hasLocalHost });
  const headingId = `settings-${section}-heading`;
  return (
    <section className="flex flex-col gap-6"
      {...(showTitle ? { "aria-labelledby": headingId } : { "aria-label": title })}
    >
      <div className="flex flex-col gap-1">
        {showTitle ? <h2 className="text-xl/7 font-semibold" id={headingId}>{title}</h2> : null}
        {showSupporting ? supporting : null}
      </div>
      {body}
    </section>
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
  { hasUpdater, hasLocalHost }: { hasUpdater: boolean; hasLocalHost: boolean },
): { title: string; supporting?: ReactNode; body: ReactNode } {
  if (section === "hosts") {
    return {
      title: "Hosts",
      supporting: <p className="text-xs/5 text-muted-foreground">The machines this device can use. It stays connected to every one paired here.</p>,
      body: (
        <HostsSection
          {...(hasLocalHost
            ? {
                thisMac: (
                  <SettingsGroup title="This Mac">
                    <div className="p-4">
                      <LocalHostSection />
                    </div>
                  </SettingsGroup>
                ),
              }
            : {})}
        />
      ),
    };
  }
  if (section === "general") {
    return {
      title: "General",
      body: (
        <div className="flex flex-col gap-6">
          <AppearanceSection />
          {hasUpdater ? (
            <SettingsGroup title="Updates">
              <div className="p-4">
                <UpdatesSection />
              </div>
            </SettingsGroup>
          ) : null}
        </div>
      ),
    };
  }
  if (view === undefined || remote === undefined) {
    // The picked machine has no settings streams until it connects.
    return {
      title: sectionTitle(section),
      body: <p className="text-xs/5 text-muted-foreground">This host isn't connected. Its settings appear once it is.</p>,
    };
  }
  switch (section) {
    case "devices":
      return {
        title: "Devices",
        supporting: <p className="text-xs/5 text-muted-foreground">Paired devices can reach this host over the secure channel.</p>,
        body: <DevicesSection view={view} remote={remote} self={device} {...(hostKey === undefined ? {} : { hostKey })} />,
      };
    case "providers":
      return {
        title: "Providers",
        supporting: (
          <p className="text-xs/5 text-muted-foreground">
            The subscriptions and API keys this host reaches models with, shared by every paired device.
          </p>
        ),
        body: <ProvidersSection view={view} remote={remote} />,
      };
    case "models":
      return {
        title: "Models",
        supporting: <p className="text-xs/5 text-muted-foreground">Used when a new conversation doesn't pick its own model.</p>,
        body: <ModelsSection view={view} remote={remote} connected={connected} />,
      };
    case "agents":
      return {
        title: "Agents",
        supporting: (
          <p className="text-xs/5 text-muted-foreground">
            Named agents the model can delegate to with <code>subagent</code> — mention one with <code>@name</code>.
          </p>
        ),
        body: (
          <div className="flex flex-col gap-6">
            <AgentsSection view={view} remote={remote} connected={connected} />
            <McpSection view={view} />
          </div>
        ),
      };
    case "chats":
      return {
        title: "Chats",
        body: (
          <div className="flex flex-col gap-6">
            <ChatsSection view={view} remote={remote} connected={connected} />
            <ArchivedSection view={view} remote={remote} connected={connected} />
          </div>
        ),
      };
    case "about":
      return {
        title: "About",
        body: (
          <div className="flex flex-col gap-6">
            <HostNameGroup view={view} remote={remote} connected={connected} />
            <section aria-label="Version">
              <SettingsGroup title="Version">
                <HostUpgradeSection view={view} remote={remote} />
              </SettingsGroup>
            </section>
            <AboutDetails view={view} />
          </div>
        ),
      };
  }
}

function ModelsSection({ view, remote, connected }: { view: DurableView; remote: RemoteDurable; connected: boolean }) {
  const settings = view.settings;
  if (settings === null) {
    return (
      <Alert variant="warning">
        <AlertTitle>This host is too old for settings</AlertTitle>
        <AlertDescription>Run `pinomad upgrade` on the host.</AlertDescription>
      </Alert>
    );
  }
  const model = view.models.find((each) => sameModel(each, settings.defaultModel ?? undefined));
  const modelGroups = [...new Set(view.models.map((each) => each.provider))].map((provider) => ({
    provider,
    items: view.models.filter((each) => each.provider === provider),
  }));
  const levels = model?.thinkingLevels ?? [];
  const customized = settings.custom.includes("defaultModel") || settings.custom.includes("defaultThinkingLevel");
  return (
    <SettingsGroup>
      <div className={GROUP_ROWS}>
        <SettingsRow label="Default model">
          <Combobox
            items={modelGroups}
            value={model ?? null}
            itemToStringLabel={(each: ModelSummary) => each.name}
            isItemEqualToValue={(a: ModelSummary, b: ModelSummary) => sameModel(a, b)}
            disabled={!connected || view.models.length === 0}
            onValueChange={(picked: ModelSummary | null) => {
              if (picked !== null) {
                void remote.controller.updateSettings({ defaultModel: { provider: picked.provider, modelId: picked.modelId } });
              }
            }}
          >
            <ComboboxTrigger aria-label="Default model" data-size="sm" data-variant="outline" className={selectTriggerClassName}>
              {model === undefined ? null : <ModelLogo model={model} size={14} />}
              <ComboboxValue placeholder="Pi's default" />
            </ComboboxTrigger>
            <ComboboxContent className="min-w-64">
              <ComboboxInput aria-label="Search models" placeholder="Search models" showTrigger={false} />
              <ComboboxEmpty>No models match</ComboboxEmpty>
              <ComboboxList>
                {(group: { provider: string; items: ModelSummary[] }) => (
                  <ComboboxGroup key={group.provider} items={group.items}>
                    <ComboboxLabel>{group.provider}</ComboboxLabel>
                    <ComboboxCollection>
                      {(each: ModelSummary) => (
                        <ComboboxItem key={`${each.provider}/${each.modelId}`} value={each}>
                          <ModelLogo model={each} size={14} reserve />
                          {each.name}
                        </ComboboxItem>
                      )}
                    </ComboboxCollection>
                  </ComboboxGroup>
                )}
              </ComboboxList>
            </ComboboxContent>
          </Combobox>
        </SettingsRow>
        {/* A model that can't reason has nothing to pick here. */}
        {levels.length > 1 ? (
          <SettingsRow label="Thinking" description="How long the model reasons before it answers">
            <Select
              items={levels.map((level) => ({ value: level, label: thinkingLevelLabels[level] }))}
              disabled={!connected}
              value={settings.defaultThinkingLevel ?? "off"}
              onValueChange={(level: string | null) => {
                if (level !== null) void remote.controller.updateSettings({ defaultThinkingLevel: level as ThinkingLevel });
              }}
            >
              <SelectTrigger aria-label="Thinking" size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {levels.map((level) => (
                    <SelectItem key={level} value={level}>{thinkingLevelLabels[level]}</SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </SettingsRow>
        ) : null}
        {customized ? (
          <div className="flex justify-end px-4 py-3">
            <Button
              variant="secondary"
              size="sm"
              disabled={!connected}
              onClick={() => void remote.controller.updateSettings({ defaultModel: null, defaultThinkingLevel: null })}
            >
              Use pi's defaults
            </Button>
          </div>
        ) : null}
      </div>
    </SettingsGroup>
  );
}

function ChatsSection({ view, remote, connected }: { view: DurableView; remote: RemoteDurable; connected: boolean }) {
  const settings = view.settings;
  if (settings === null) {
    return (
      <Alert variant="warning">
        <AlertTitle>This host is too old for settings</AlertTitle>
        <AlertDescription>Run `pinomad upgrade` on the host.</AlertDescription>
      </Alert>
    );
  }
  return (
    <SettingsGroup title="Messages sent while the agent works">
      <div className={GROUP_ROWS}>
        <ModeSetting
          title="Steer messages"
          description="Delivered at the next turn"
          value={settings.steeringMode}
          customized={settings.custom.includes("steeringMode")}
          disabled={!connected}
          onChange={(mode) => void remote.controller.updateSettings({ steeringMode: mode })}
          onReset={() => void remote.controller.updateSettings({ steeringMode: null })}
        />
        <ModeSetting
          title="Follow-up messages"
          description="Delivered once the agent finishes"
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
  return (
    <section className="flex flex-col gap-2" aria-label="Archived">
      <h4 className="text-sm/5 font-bold">Archived</h4>
      <p className="text-xs/5 text-muted-foreground">
        Hidden from the sidebar. Restoring one brings back its forks and subagents.
      </p>
      {archived.length === 0 ? (
        <p className="text-xs/5 text-muted-foreground">No archived conversations.</p>
      ) : (
        <SettingsGroup>
          <ItemGroup className={GROUP_ROWS}>
            {archived.map(({ node, project }) => {
              const title = node.summary.title ?? "New conversation";
              const updatedAt = familyUpdatedAt(node);
              return (
                <Item key={node.summary.id} render={<li />}>
                  <ItemContent>
                    <ItemTitle>{title}</ItemTitle>
                    <ItemDescription>
                      {[project?.name ?? "Chat", updatedAt === undefined ? undefined : relativeTime(updatedAt, now)]
                        .filter((part) => part !== undefined)
                        .join(" · ")}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Button
                      aria-label={`Restore ${title}`}
                      variant="secondary"
                      size="sm"
                      disabled={!connected}
                      onClick={() => void remote.controller.archive(node.summary.id, false)}
                    >
                      <ArchiveRestore aria-hidden="true" />
                      Restore
                    </Button>
                  </ItemActions>
                </Item>
              );
            })}
          </ItemGroup>
        </SettingsGroup>
      )}
    </section>
  );
}

function McpSection({ view }: { view: DurableView }) {
  const mcp = view.mcp;
  return (
    <section className="flex flex-col gap-2" aria-label="MCP servers">
      <h4 className="text-sm/5 font-bold">MCP servers</h4>
      {mcp === null ? (
        <p className="text-xs/5 text-muted-foreground">Loading…</p>
      ) : mcp.servers.length === 0 ? (
        <p className="text-xs/5 text-muted-foreground">No servers configured.</p>
      ) : (
        <SettingsGroup>
          <ItemGroup className={GROUP_ROWS}>
            {mcp.servers.map((server) => (
              <Item key={server.name} render={<li />}>
                <ItemContent>
                  <ItemTitle>{server.name}</ItemTitle>
                </ItemContent>
                <ItemActions>
                  <Badge>{server.state}</Badge>
                </ItemActions>
              </Item>
            ))}
          </ItemGroup>
        </SettingsGroup>
      )}
    </section>
  );
}

function HostNameGroup({ view, remote, connected }: { view: DurableView; remote: RemoteDurable; connected: boolean }) {
  const settings = view.settings;
  if (settings === null || !hostSupportsFeature(view.host?.protocol.minor ?? 0, "hostName")) return null;
  return (
    <SettingsGroup>
      <HostNameField settings={settings} remote={remote} connected={connected} />
    </SettingsGroup>
  );
}

function AboutDetails({ view }: { view: DurableView }) {
  const host = view.host;
  return (
    <SettingsGroup title="Details">
      <div className={GROUP_ROWS}>
        {/* A host with the upgrade stream names its release under Version. */}
        {view.upgrade === null ? (
          <SettingsRow label="Host version">
            <span className="text-sm/5 text-muted-foreground">{host?.version ?? "Source checkout"}</span>
          </SettingsRow>
        ) : null}
        <SettingsRow label="Protocol">
          <span className="text-sm/5 text-muted-foreground tabular-nums">
            {host === undefined ? "—" : `${host.protocol.major}.${host.protocol.minor}`}
          </span>
        </SettingsRow>
        <SettingsRow label="Website">
          {/* `?home` keeps the site on its home page instead of forwarding
              a marked browser back to the app. */}
          <Link href="https://pinomad.si/?home" external className="text-sm/5">
            pinomad.si
          </Link>
        </SettingsRow>
      </div>
    </SettingsGroup>
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
  const invalid = draft !== "" && cleaned === "";
  return (
    <SettingsRow label="Host name" description="How paired devices name this machine.">
      <Field disabled={!connected} invalid={invalid} className="w-40 max-w-full">
        <Input
          aria-label="Host name"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && canSave) save();
          }}
        />
        <FieldError>{invalid ? "The name needs at least one displayable character" : undefined}</FieldError>
      </Field>
      {settings.custom.includes("hostName") ? (
        <Button
          variant="secondary"
          size="sm"
          disabled={!connected}
          onClick={() => void remote.controller.updateSettings({ hostName: null })}
        >
          Use machine name
        </Button>
      ) : null}
      <Button variant="secondary" size="sm" disabled={!canSave} onClick={save}>Save</Button>
    </SettingsRow>
  );
}

function ModeSetting({
  title,
  description,
  value,
  customized,
  disabled,
  onChange,
  onReset,
}: {
  title: string;
  description: string;
  value: QueueMode;
  customized: boolean;
  disabled: boolean;
  onChange: (mode: QueueMode) => void;
  onReset: () => void;
}) {
  return (
    <SettingsRow label={title} description={description}>
      {customized ? (
        <Button variant="secondary" size="sm" disabled={disabled} onClick={onReset}>Use pi's default</Button>
      ) : null}
      <SegmentedControl
        value={value}
        onValueChange={(next) => onChange(next as QueueMode)}
        aria-label={title}
        disabled={disabled}
      >
        <SegmentedControlItem value="one-at-a-time">One at a time</SegmentedControlItem>
        <SegmentedControlItem value="all">All at once</SegmentedControlItem>
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
      <Alert variant="warning">
        <AlertTitle>This host is too old for named agents</AlertTitle>
        <AlertDescription>Run `pinomad upgrade` on the host.</AlertDescription>
      </Alert>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          disabled={!connected}
          onClick={() => setEditor({ mode: "create" })}
        >
          New agent
        </Button>
      </div>
      {agents.roles.length === 0 && agents.problems.length === 0 ? (
        <p className="text-xs/5 text-muted-foreground">No named agents yet.</p>
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
    </div>
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
    setError(undefined);
    void remote.controller.deleteAgent(role.name).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason));
    });
  };
  return (
    <Card>
      <CardContent>
        <div className="flex items-start gap-3">
          <div className="flex flex-col gap-1" style={{ flex: 1, minInlineSize: 0 }}>
            <h3 className="text-[1.0625rem]/6 font-bold">{role.name}</h3>
            <p className="text-xs/5 text-muted-foreground">{role.description}</p>
            {role.model === undefined && role.thinkingLevel === undefined ? null : (
              <div className="flex flex-wrap gap-1">
                {role.model === undefined ? null : (
                  <Badge>{modelSummary?.name ?? role.model}</Badge>
                )}
                {role.thinkingLevel === undefined ? null : (
                  <Badge>{thinkingLevelLabels[role.thinkingLevel]}</Badge>
                )}
                {role.model !== undefined && modelSummary === undefined ? (
                  <Badge variant="warning">Model not available</Badge>
                ) : null}
              </div>
            )}
          </div>
          {confirming ? null : (
            <div className="flex items-center gap-1">
              <DropdownMenu>
                <DropdownMenuTrigger
                  disabled={!connected}
                  render={<IconButton icon={<MoreHorizontal aria-hidden="true" />} label={`${role.name} actions`} tooltip={`${role.name} actions`} size="sm" />}
                />
                <DropdownMenuContent>
                  <DropdownMenuItem onClick={onEdit}>Edit</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setConfirming(true)}>Delete</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
        </div>
        {confirming ? (
          <div className="flex flex-col gap-2" style={{ marginBlockStart: "var(--spacing-4)" }}>
            <p className="text-xs/5 text-muted-foreground">Conversations already using this agent keep their copy.</p>
            <div className="flex items-center gap-2">
              <Button variant="destructive" size="sm" disabled={!connected} onClick={remove}>Delete</Button>
              <Button variant="secondary" size="sm" onClick={() => setConfirming(false)}>Cancel</Button>
            </div>
          </div>
        ) : null}
        <FormError>{error}</FormError>
      </CardContent>
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
    setError(undefined);
    void remote.controller.deleteAgent(problem.file.slice(0, -".md".length)).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason));
    });
  };
  return (
    <Card>
      <CardContent>
        <div className="flex items-start gap-3">
          <div className="flex flex-col gap-1" style={{ flex: 1, minInlineSize: 0 }}>
            <h3 className="text-[1.0625rem]/6 font-bold">{problem.file}</h3>
            <div className="flex flex-wrap gap-1">
              <Badge variant="warning">Not loaded</Badge>
            </div>
            <p className="text-xs/5 text-muted-foreground">{problem.reason}</p>
            <p className="text-xs/5 text-muted-foreground">Fix this file on the host.</p>
          </div>
          {confirming || !deletable ? null : (
            <div className="flex items-center gap-1">
              <DropdownMenu>
                <DropdownMenuTrigger
                  disabled={!connected}
                  render={<IconButton icon={<MoreHorizontal aria-hidden="true" />} label={`${problem.file} actions`} tooltip={`${problem.file} actions`} size="sm" />}
                />
                <DropdownMenuContent>
                  <DropdownMenuItem onClick={() => setConfirming(true)}>Delete</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
        </div>
        {confirming ? (
          <div className="flex flex-col gap-2" style={{ marginBlockStart: "var(--spacing-4)" }}>
            <div className="flex items-center gap-2">
              <Button variant="destructive" size="sm" disabled={!connected} onClick={remove}>Delete</Button>
              <Button variant="secondary" size="sm" onClick={() => setConfirming(false)}>Cancel</Button>
            </div>
          </div>
        ) : null}
        <FormError>{error}</FormError>
      </CardContent>
    </Card>
  );
}
