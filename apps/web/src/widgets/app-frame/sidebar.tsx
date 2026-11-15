import { cn } from "cn";
import { Button } from "../../shared/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../../shared/ui/dropdown-menu.tsx";
import { IconButton } from "../../shared/ui/icon-button.tsx";
import { SideNavItem, SideNavSection } from "../../shared/ui/side-nav.tsx";
import { Fragment, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { ConversationNode, Home, Project } from "@pinomad/protocol/organization.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import type { DurableView } from "@pinomad/protocol/view.ts";
import { familyStatus, threadsOf, type FamilyStatus } from "@pinomad/client/family.ts";
import { useAppUpdate } from "../../entities/app-update/use-app-update.ts";
import { ArchiveArrowDown, ChatBubble, ChevronDown, ChevronRight, Computer, FolderAdd, FolderClosed, FolderOpenState, MoreHorizontal, Pencil, Plus, Settings, Trash2, UserCircle } from "../../shared/ui/icons.tsx";
import { DisclosureButton, DisclosureChevron } from "../../shared/ui/disclosure-button.tsx";
import { AnimatedNewChat, AnimatedSidebar } from "../../shared/ui/animated-icons.tsx";
import { AddProjectDialog, RemoveProjectDialog } from "./project-dialogs.tsx";
import { RenameConversationDialog } from "./rename-dialog.tsx";
import { HostsMenuItems } from "./hosts.tsx";
import { useAccountModel } from "../../entities/account/account-context.tsx";
import { clientDeviceName } from "../../address.ts";
import { StatusDot } from "../../shared/ui/status-dot.tsx";
import { Badge } from "../../shared/ui/badge.tsx";
import { Avatar, AvatarFallback, initials } from "../../shared/ui/avatar.tsx";

const PROJECT_EXPANDED_KEY = "pinomad.projectSidebar.expanded";

/** Project folds belong to one host: the same path may exist on both. */
const projectExpandedKey = (machineKey: string): string => `${PROJECT_EXPANDED_KEY}.${machineKey}`;

const readExpandedProjects = (machineKey: string): Record<string, boolean> => {
  const raw = window.localStorage.getItem(projectExpandedKey(machineKey));
  if (raw === null) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, boolean>;
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, boolean] => typeof entry[0] === "string" && typeof entry[1] === "boolean",
      ),
    );
  } catch {
    return {};
  }
};

const writeExpandedProjects = (machineKey: string, expanded: Record<string, boolean>): void => {
  window.localStorage.setItem(projectExpandedKey(machineKey), JSON.stringify(expanded));
};

const flattenNodes = (nodes: readonly ConversationNode[]): ConversationNode[] =>
  nodes.flatMap((node) => [node, ...flattenNodes(node.children)]);

/** The SideNav header band: the collapse toggle. The slot adds 8px block
    padding each side, so 24px of band lands the toggle on the same 40px
    center line as the main header (Pace's spacer trick). */
export function SidebarHeaderBand({
  onCollapse,
  safeLeft,
}: {
  onCollapse?: () => void;
  /** Left inset reserved for the macOS traffic lights when the sidebar owns the corner. */
  safeLeft?: string;
}) {
  return (
    <div
      className="pinomad-drag flex h-6 items-center px-2"
      style={safeLeft === undefined ? undefined : { paddingLeft: safeLeft }}
    >
      <IconButton
        icon={<AnimatedSidebar className="size-4" />}
        label="Collapse sidebar"
        size="sm"
        variant="ghost"
        onClick={onCollapse}
      />
    </div>
  );
}

/**
 * The user bar at the foot of the sidebar: the account menu on the left and
 * Settings on the right. Dialogs are hoisted into AppFrame — inside the phone
 * drawer they would unmount with the drawer this click just closed.
 */
export function SidebarFooter({
  onOpenSettings,
  onOpenAccount,
  onLocateHost,
  onSelect,
}: {
  onOpenSettings: () => void;
  onOpenAccount: () => void;
  /** Bring a machine's sidebar group into view; absent where there is no group to show. */
  onLocateHost?: (hostKey: string) => void;
  onSelect?: () => void;
}) {
  const update = useAppUpdate();
  return (
    <div className="flex items-center gap-1">
      <div className="min-w-0 flex-1">
        <UserMenu
          onOpenAccount={() => {
            onSelect?.();
            onOpenAccount();
          }}
          onOpenSettings={() => {
            onSelect?.();
            onOpenSettings();
          }}
          {...(onLocateHost === undefined ? {} : { onLocateHost })}
        />
      </div>
      <span className="relative inline-flex">
        <IconButton
          icon={<Settings aria-hidden="true" />}
          label="Settings"
          tooltip="Settings"
          size="sm"
          variant="ghost"
          onClick={() => {
            onSelect?.();
            onOpenSettings();
          }}
        />
        {update?.status.state === "ready" ? (
          <span
            aria-label="Update ready"
            className="pointer-events-none absolute right-1 top-1 size-2 rounded-full bg-primary"
            role="img"
          />
        ) : null}
      </span>
    </div>
  );
}

/**
 * The account this client is signed in to (ADR-0022), with this device's hosts
 * and Settings in its menu. Without an account API, the device's pairing name
 * stands in and the account row is read-only.
 */
function UserMenu({
  onOpenAccount,
  onOpenSettings,
  onLocateHost,
}: {
  onOpenAccount: () => void;
  onOpenSettings: () => void;
  onLocateHost?: (hostKey: string) => void;
}) {
  const account = useAccountModel();
  const state = account.state;
  const trigger = useRef<HTMLButtonElement>(null);
  const [deviceName, setDeviceName] = useState<string>();
  useEffect(() => {
    if (state.status !== "unavailable") return;
    let live = true;
    void clientDeviceName().then((name) => {
      if (live) setDeviceName(name);
    });
    return () => {
      live = false;
    };
  }, [state.status]);

  const title = state.status === "signed-in" ? state.user : state.status === "signed-out" ? "Sign in" : deviceName;
  const email = state.status === "signed-in" && state.email !== state.user ? state.email : undefined;
  const openFromMenu = (open: () => void): void => {
    // Settings remembers this still-mounted trigger, not the menu item that is
    // about to unmount, so closing can return focus here.
    trigger.current?.focus();
    open();
  };
  const summary = (
    <>
      <Avatar size="sm" aria-label={title ?? "This device"}>
        <AvatarFallback>
          {state.status === "signed-in" ? initials(state.user) : <UserCircle aria-hidden="true" className="size-6" />}
        </AvatarFallback>
      </Avatar>
      <span className="flex min-w-0 flex-col text-left">
        <span className="truncate text-sm/5 font-semibold">{title}</span>
        {email === undefined ? null : <span className="truncate text-xs/5 text-muted-foreground">{email}</span>}
      </span>
    </>
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            ref={trigger}
            variant="ghost"
            size="sm"
            aria-label={`Account menu: ${title ?? "this device"}`}
            className="w-full max-w-full justify-start"
          >
            {state.status === "signed-in" ? (
              <Avatar size="xs" aria-label={state.user}>
                <AvatarFallback>{initials(state.user)}</AvatarFallback>
              </Avatar>
            ) : (
              <UserCircle aria-hidden="true" />
            )}
            <span className="min-w-0 flex-1 truncate text-left">{title}</span>
            <ChevronDown aria-hidden="true" className="size-3.5 text-muted-foreground" />
          </Button>
        }
      />
      <DropdownMenuContent aria-label="Account" side="top" align="start" className="w-64">
        {state.status === "signed-in" || state.status === "signed-out" ? (
          <DropdownMenuItem
            aria-label={state.status === "signed-in" ? `Account: ${state.user}` : "Sign in"}
            className="min-h-14 gap-3 px-2 py-2"
            onClick={() => openFromMenu(onOpenAccount)}
          >
            {summary}
          </DropdownMenuItem>
        ) : (
          <DropdownMenuGroup>
            <DropdownMenuLabel className="flex min-h-14 items-center gap-3 px-2 py-2 text-sm/5 text-foreground">
              {summary}
            </DropdownMenuLabel>
          </DropdownMenuGroup>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger label="Hosts">
            <Computer aria-hidden="true" />
            Hosts
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent aria-label="Hosts">
            <HostsMenuItems {...(onLocateHost === undefined ? {} : { onLocate: onLocateHost })} />
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuItem onClick={() => openFromMenu(onOpenSettings)}>
          <Settings aria-hidden="true" />
          Settings
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Codex-style section header (Pace's SidebarSectionHeader): the title is the
// collapse toggle and the creation action only surfaces on hover/focus.
// SideNavSection keeps its own title visually hidden so the group still has
// an accessible name.
function SidebarSectionHeader({
  title,
  expanded,
  contentId,
  onToggle,
  actions,
  pinnedActions = false,
}: {
  title: string;
  expanded: boolean;
  contentId: string;
  onToggle: () => void;
  actions: ReactNode;
  /** Actions always visible instead of hover-only. */
  pinnedActions?: boolean;
}) {
  return (
    <div className="pigui-sidenav-section-header">
      <DisclosureButton
        open={expanded}
        className="pigui-sidenav-section-toggle"
        aria-label={expanded ? `Collapse ${title}` : `Expand ${title}`}
        aria-controls={contentId}
        onClick={onToggle}
      >
        <span className="pigui-sidenav-section-toggle__title">{title}</span>
        {/* The same chevron glyph the selectors use, so every disclosure reads alike. */}
        <span
          aria-hidden="true"
          className="pigui-sidenav-section-toggle__chevron"
          data-expanded={expanded ? "true" : "false"}
        >
          <DisclosureChevron className="size-4" />
        </span>
      </DisclosureButton>
      <div className={cn("ms-auto flex items-center gap-0.5", !pinnedActions && "pigui-sidenav-hover-actions")}>
        {actions}
      </div>
    </div>
  );
}

/** Fixed-size glyph slot so rows with and without status stay aligned. */
function SessionGlyphSlot() {
  return <span className="pigui-session-glyph" data-testid="session-glyph" />;
}

const FAMILY_STATUS_TEXT = { "needs-answer": "Waiting for your answer", failed: "Failed", running: "Running" } as const;

/**
 * The whole family's most urgent status in the glyph slot. The dot
 * is decorative inside the row's <button> — aria-hidden so the accessible name
 * stays exactly the title; the status itself is machine-readable on the row.
 * A family waiting for an answer gets the end tag instead (`NeedsAnswerTag`).
 */
function FamilyStatusGlyph({ status }: { status: Exclude<FamilyStatus, "needs-answer"> }) {
  const variant = status === "failed" ? "error" : "success";
  const tooltip = FAMILY_STATUS_TEXT[status];
  return (
    <span className="pigui-session-glyph" aria-hidden="true">
      <StatusDot variant={variant} label={tooltip} tooltip={tooltip} pulsing={status !== "failed"} />
    </span>
  );
}



/** A folder row's glyph: its own icon at rest, a turning chevron on hover. */
function FoldIndicator({
  expanded,
  closed: Closed,
  open: Open,
}: {
  expanded: boolean;
  closed: typeof FolderClosed;
  open: typeof FolderClosed;
}) {
  const StateIcon = expanded ? Open : Closed;
  return (
    <span
      aria-hidden="true"
      className="pigui-project-expansion-indicator"
      data-expanded={expanded ? "true" : "false"}
    >
      <StateIcon className="pigui-project-expansion-indicator__state" />
      <span className="pigui-project-expansion-indicator__chevron">
        <ChevronRight aria-hidden="true" className="size-4" />
      </span>
    </span>
  );
}

/**
 * One conversation row: a root or a fork. Both are independently navigable;
 * the root aggregates the whole family's status. Subagents get no rows here:
 * they are the model's tools and live in the side panel's Tasks (ADR-0047 §1).
 */
function ConversationRow({
  node,
  shown,
  disabled,
  remote,
  kind = "root",
  onOpen,
  onSelect,
}: {
  node: ConversationNode;
  shown: ConversationId | undefined;
  disabled: boolean;
  remote: RemoteDurable;
  /** A fork is an independent conversation with its own status and selection. */
  kind?: "root" | "fork";
  onOpen: (id: ConversationId) => void;
  onSelect?: () => void;
}) {
  const { summary } = node;
  const fork = kind === "fork";
  // Family status includes forks and subagents; a fork's own row carries only
  // its own status.
  const status = fork ? summary.status : familyStatus(node);
  // A fork row owns its selection. The root represents its hidden
  // descendants (subagents) but never a visible fork row.
  const forkShown = !fork && threadsOf(node).some((each) => each.summary.id === shown);
  const selected = fork
    ? summary.id === shown
    : summary.id === shown || (shown !== undefined && !forkShown && flattenNodes([node]).some((each) => each.summary.id === shown));
  const [renaming, setRenaming] = useState(false);
  const item = (
    <SideNavItem
      icon={status === undefined || status === "needs-answer" ? <SessionGlyphSlot /> : <FamilyStatusGlyph status={status} />}
      label={summary.title ?? "New conversation"}
      isSelected={selected}
      isDisabled={disabled}
      // A <button> row cannot contain the interactive … overlay; the spacer
      // reserves its single-button width so the title truncates first.
      endContent={
        <>
          {status === "needs-answer" ? (
            // Decorative like the dot: the hidden sibling below reads the status.
            <Badge aria-hidden="true" variant="warning" className="pigui-sidenav-status-tag shrink-0">
              Needs answer
            </Badge>
          ) : null}
          <span aria-hidden="true" className="pigui-sidenav-actions-spacer pigui-sidenav-actions-spacer--single" />
        </>
      }
      onClick={() => {
        onOpen(summary.id);
        onSelect?.();
      }}
    />
  );
  // Same overlay-sibling pattern as the project row: the actions menu cannot
  // live inside the SideNavItem <button>.
  return (
    <div
      className="pigui-sidenav-row-with-actions pigui-sidenav-session-row"
      data-kind={fork ? "fork" : "root"}
      {...(status === undefined ? {} : { "data-status": status })}
    >
      {item}
      {status === undefined ? null : (
        // A hidden sibling after the button puts the status right after the title in
        // reading order while the button's name stays exactly the title.
        <span className="sr-only">{FAMILY_STATUS_TEXT[status]}</span>
      )}
      <div className="flex items-center gap-0.5 pigui-sidenav-row-actions pigui-sidenav-hover-actions">
        <DropdownMenu>
          <DropdownMenuTrigger
            disabled={disabled}
            render={<IconButton icon={<MoreHorizontal aria-hidden="true" />} label="Conversation actions" size="sm" />}
          />
          <DropdownMenuContent>
            <DropdownMenuItem onClick={() => setRenaming(true)}>
              <Pencil aria-hidden="true" />
              Rename
            </DropdownMenuItem>
            {/* The host archives only top-level index entries; archiving the
                root still takes the whole family (ADR-0039 §1). */}
            {fork ? null : (
              <DropdownMenuItem onClick={() => void remote.controller.archive(summary.id, true)}>
                <ArchiveArrowDown aria-hidden="true" />
                Archive
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {renaming ? (
        <RenameConversationDialog
          summary={summary}
          remote={remote}
          connected={!disabled}
          onClose={() => setRenaming(false)}
        />
      ) : null}
    </div>
  );
}

/** One paired machine as the sidebar sees it (ADR-0035 §1). */
export interface SidebarMachine {
  /** The stored hostKey, or a fixed key for a token client. */
  readonly key: string;
  readonly label: string;
  /** The host's latest snapshot; absent until its first connection is ready. */
  readonly view?: DurableView;
  readonly remote?: RemoteDurable;
  /** The host refused this device (4401); its last snapshot is no longer this device's to browse. */
  readonly rejected?: boolean;
}

/** A request to bring one machine's group into view; `seq` repeats a locate. */
export interface SidebarLocate {
  readonly key: string;
  readonly seq: number;
}

const machineExpandedKey = (key: string): string => `pinomad.sidebarMachine.${key}.expanded`;

/** Not a filesystem path, so it can share the project fold map. */
const CHATS_FOLD = ":chats";

/**
 * The sidebar's shared content — the global "New chat" entry plus one group per
 * paired machine (machine → project → conversation, ADR-0035 §1) — rendered
 * inside the desktop SideNav and inside the phone drawer.
 */
export function SidebarContent({
  machines,
  focusKey,
  draftingChat,
  shownId,
  locate,
  onNewChat,
  onDraft,
  onOpen,
  onShowMachine,
  onSelect,
}: {
  machines: readonly SidebarMachine[];
  /** The machine the main column shows; only its rows can be selected. */
  focusKey: string | undefined;
  draftingChat: boolean;
  shownId: ConversationId | undefined;
  locate?: SidebarLocate;
  /** The global New chat chooses its own machine (ADR-0035 §7). */
  onNewChat?: () => void;
  onDraft: (key: string, home: Home) => void;
  onOpen: (key: string, id: ConversationId) => void;
  /** Focus a machine that has nothing to list, so the main column explains why. */
  onShowMachine?: (key: string) => void;
  onSelect?: () => void;
}) {
  return (
    <>
      <SideNavSection isHeaderHidden title="New chat">
        <SideNavItem
          icon={<AnimatedNewChat className="size-4" />}
          label="New chat"
          isSelected={draftingChat}
          isDisabled={onNewChat === undefined}
          onClick={() => {
            onNewChat?.();
            onSelect?.();
          }}
        />
      </SideNavSection>
      {machines.map((machine) => (
        <MachineSection
          key={machine.key}
          machine={machine}
          shownId={machine.key === focusKey ? shownId : undefined}
          locateSeq={locate?.key === machine.key ? locate.seq : undefined}
          onDraft={(home) => onDraft(machine.key, home)}
          onOpen={(id) => onOpen(machine.key, id)}
          {...(onShowMachine === undefined ? {} : { onShow: () => onShowMachine(machine.key) })}
          onSelect={onSelect}
        />
      ))}
    </>
  );
}

/**
 * One machine's group. Its header carries no connection status (#213): that
 * lives in the footer's hosts list. Dialogs and folds here belong to this
 * machine's remote alone, whichever machine is focused.
 */
function MachineSection({
  machine,
  shownId,
  locateSeq,
  onDraft,
  onOpen,
  onShow,
  onSelect,
}: {
  machine: SidebarMachine;
  shownId: ConversationId | undefined;
  locateSeq: number | undefined;
  onDraft: (home: Home) => void;
  onOpen: (id: ConversationId) => void;
  onShow?: () => void;
  onSelect?: (() => void) | undefined;
}) {
  const { key, label, view, remote, rejected = false } = machine;
  const disabled = view?.connection !== "connected";
  const contentId = useId();
  const headerRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(() => window.localStorage.getItem(machineExpandedKey(key)) !== "false");
  const setMachineExpanded = (next: boolean): void => {
    window.localStorage.setItem(machineExpandedKey(key), String(next));
    setExpanded(next);
  };
  const [addOpen, setAddOpen] = useState(false);
  const [removing, setRemoving] = useState<Project>();
  const [folds, setFolds] = useState(() => readExpandedProjects(key));
  const organized = rejected ? undefined : view?.organized;
  const start = (home: Home): void => {
    onDraft(home);
    onSelect?.();
  };
  const shownFold = useMemo(() => {
    if (shownId === undefined || organized === undefined) return undefined;
    if (flattenNodes(organized.chats).some((node) => node.summary.id === shownId)) return CHATS_FOLD;
    return organized.projects.find(({ conversations }) =>
      flattenNodes(conversations).some((node) => node.summary.id === shownId),
    )?.project.path;
  }, [organized, shownId]);
  // Keep the shown conversation visible even if the user folded its machine or folder.
  useEffect(() => {
    if (shownFold === undefined) return;
    if (!expanded) setMachineExpanded(true);
    setFolds((prev) => {
      if (prev[shownFold] !== false) return prev;
      const next = { ...prev, [shownFold]: true };
      writeExpandedProjects(key, next);
      return next;
    });
    // Only a move of the shown conversation reopens; a fold made afterwards stays.
  }, [key, shownFold]);
  // A locate from the hosts list opens the group and scrolls it into view
  // without moving focus (#427).
  useEffect(() => {
    if (locateSeq === undefined) return;
    setMachineExpanded(true);
    headerRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [locateSeq]);
  const toggleFold = (path: string): void =>
    setFolds((prev) => {
      const next = { ...prev, [path]: !(prev[path] ?? true) };
      writeExpandedProjects(key, next);
      return next;
    });
  // A root and its forks are sibling rows in the same project / Chat group:
  // root order stays, forks follow their root in the family's stable,
  // depth-first order (legacy nested forks included).
  const familyRows = (node: ConversationNode) =>
    remote === undefined ? null : (
      <Fragment key={node.summary.id}>
        <ConversationRow
          node={node}
          shown={shownId}
          disabled={disabled}
          remote={remote}
          onOpen={onOpen}
          onSelect={onSelect}
        />
        {threadsOf(node).map((fork) => (
          <ConversationRow
            key={fork.summary.id}
            node={fork}
            shown={shownId}
            disabled={disabled}
            remote={remote}
            kind="fork"
            onOpen={onOpen}
            onSelect={onSelect}
          />
        ))}
      </Fragment>
    );
  const chatsOpen = folds[CHATS_FOLD] ?? true;

  return (
    <SideNavSection isHeaderHidden title={label}>
      <div ref={headerRef}>
        <SidebarSectionHeader
          title={label}
          expanded={expanded}
          contentId={contentId}
          onToggle={() => setMachineExpanded(!expanded)}
          actions={
            <>
              <IconButton
                icon={<Plus aria-hidden="true" />}
                label={`New chat on ${label}`}
                tooltip="New chat"
                size="sm"
                variant="ghost"
                disabled={disabled}
                onClick={() => start({ kind: "chat" })}
              />
              <IconButton
                icon={<FolderAdd aria-hidden="true" />}
                label={`Add project on ${label}`}
                tooltip="Add project"
                size="sm"
                variant="ghost"
                disabled={disabled}
                onClick={() => setAddOpen(true)}
              />
            </>
          }
        />
      </div>
      <div className="flex flex-col gap-0.5" id={contentId}>
        {!expanded ? null : organized === undefined ? (
          <SideNavItem
            icon={<SessionGlyphSlot />}
            label={rejected ? "Not paired" : "No conversations available"}
            isDisabled={onShow === undefined}
            onClick={() => {
              onShow?.();
              onSelect?.();
            }}
          />
        ) : organized.chats.length === 0 && organized.projects.length === 0 ? (
          <SideNavItem icon={<SessionGlyphSlot />} isDisabled label="No conversations" />
        ) : (
          <>
            {organized.chats.length === 0 ? null : (
              // Same wrapper as a project row, so its conversations share the
              // project rows' indent (see .pigui-sidenav-row-with-actions).
              <div className="pigui-sidenav-row-with-actions">
                <SideNavItem
                  collapsible={{ isCollapsed: !chatsOpen, onCollapsedChange: () => toggleFold(CHATS_FOLD) }}
                  icon={<FoldIndicator expanded={chatsOpen} closed={ChatBubble} open={ChatBubble} />}
                  label="Chats"
                  isDisabled={disabled}
                >
                  {organized.chats.map(familyRows)}
                </SideNavItem>
              </div>
            )}
            {organized.projects.map(({ project, conversations }) => {
              const open = folds[project.path] ?? true;
              return (
                <div key={project.path} className="pigui-sidenav-row-with-actions">
                  <SideNavItem
                    collapsible={{ isCollapsed: !open, onCollapsedChange: () => toggleFold(project.path) }}
                    icon={<FoldIndicator expanded={open} closed={FolderClosed} open={FolderOpenState} />}
                    label={project.name}
                    isDisabled={disabled}
                    // A <button> row cannot contain the interactive actions;
                    // this only reserves their width so the label truncates
                    // before the overlay.
                    endContent={<span aria-hidden="true" className="pigui-sidenav-actions-spacer" />}
                  >
                    {conversations.length === 0 ? (
                      <SideNavItem icon={<SessionGlyphSlot />} isDisabled label="No conversations" />
                    ) : (
                      conversations.map(familyRows)
                    )}
                  </SideNavItem>
                  <div className="flex items-center gap-0.5 pigui-sidenav-row-actions">
                    <div className="flex items-center gap-0.5 pigui-sidenav-hover-actions">
                      <IconButton
                        icon={<Plus aria-hidden="true" />}
                        label={`New conversation in ${project.name}`}
                        size="sm"
                        variant="ghost"
                        disabled={disabled}
                        onClick={() => start({ kind: "project", path: project.path })}
                      />
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          disabled={disabled}
                          render={
                            <IconButton icon={<MoreHorizontal aria-hidden="true" />} label={`Project actions for ${project.name}`} size="sm" />
                          }
                        />
                        <DropdownMenuContent>
                          <DropdownMenuItem onClick={() => setRemoving(project)}>
                            <Trash2 aria-hidden="true" />
                            Remove project
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>
                </div>
              );
            })}
          </>
        )}
      </div>
      {addOpen && remote !== undefined ? (
        <AddProjectDialog
          remote={remote}
          connected={!disabled}
          onAdded={(project) => {
            setAddOpen(false);
            start({ kind: "project", path: project.path });
          }}
          onClose={() => setAddOpen(false)}
        />
      ) : null}
      {removing === undefined || remote === undefined ? null : (
        <RemoveProjectDialog project={removing} remote={remote} connected={!disabled} onClose={() => setRemoving(undefined)} />
      )}
    </SideNavSection>
  );
}
