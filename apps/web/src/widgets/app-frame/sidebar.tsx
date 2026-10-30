import { Avatar } from "@astryxdesign/core/Avatar";
import { Button } from "@astryxdesign/core/Button";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { SideNavItem, SideNavSection } from "@astryxdesign/core/SideNav";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { ConversationNode, Home, Project } from "@pinomad/protocol/organization.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import type { DurableView } from "@pinomad/protocol/view.ts";
import { familyStatus, taskGroupsOf, type FamilyStatus } from "@pinomad/client/family.ts";
import { useAppUpdate } from "../../entities/app-update/use-app-update.ts";
import { ArchiveArrowDown, Bot, ChatBubble, FolderAdd, FolderClosed, FolderOpenState, MoreHorizontal, Pencil, Plus, Settings, Trash2, UserCircle } from "../../shared/ui/icons.tsx";
import { AnimatedNewChat, AnimatedSidebar } from "../../shared/ui/animated-icons.tsx";
import { AddProjectDialog, RemoveProjectDialog } from "./project-dialogs.tsx";
import { RenameConversationDialog } from "./rename-dialog.tsx";
import { HostsMenu } from "./hosts.tsx";
import { useAccountModel } from "../../entities/account/account-context.tsx";
import { clientDeviceName } from "../../address.ts";

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
 * The user bar at the foot of the sidebar: who is signed in on the left; the
 * hosts list and Settings on the right. Dialogs are hoisted into AppFrame —
 * inside MobileNav they would render in the drawer that this click just
 * closed.
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
        <UserChip
          onOpenAccount={() => {
            onSelect?.();
            onOpenAccount();
          }}
        />
      </div>
      <HostsMenu {...(onLocateHost === undefined ? {} : { onLocate: onLocateHost })} />
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
 * The account this client is signed in to (ADR-0022). Where the page can't
 * reach an account API at all, the device's own name stands in — the one it
 * pairs under.
 */
function UserChip({ onOpenAccount }: { onOpenAccount: () => void }) {
  const account = useAccountModel();
  const status = account.state.status;
  const [deviceName, setDeviceName] = useState<string>();
  useEffect(() => {
    if (status !== "unavailable") return;
    let live = true;
    void clientDeviceName().then((name) => {
      if (live) setDeviceName(name);
    });
    return () => {
      live = false;
    };
  }, [status]);
  if (account.state.status === "signed-in") {
    const { user } = account.state;
    return (
      <Button
        label={user}
        icon={<Avatar name={user} size="xsm" tooltip={false} />}
        variant="ghost"
        size="sm"
        onClick={onOpenAccount}
      />
    );
  }
  if (status === "signed-out") {
    return <Button label="Sign in" icon={<UserCircle aria-hidden="true" />} variant="ghost" size="sm" onClick={onOpenAccount} />;
  }
  return <span className="block truncate px-2 text-sm text-muted">{deviceName}</span>;
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
      <button
        type="button"
        className="pigui-sidenav-section-toggle"
        aria-label={expanded ? `Collapse ${title}` : `Expand ${title}`}
        aria-expanded={expanded}
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
          <Icon icon="chevronRight" size="sm" color="inherit" />
        </span>
      </button>
      <HStack className={pinnedActions ? undefined : "pigui-sidenav-hover-actions"} gap={0.5} vAlign="center">
        {actions}
      </HStack>
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
 */
function FamilyStatusGlyph({ status }: { status: FamilyStatus }) {
  const variant = status === "needs-answer" ? "warning" : status === "failed" ? "error" : "success";
  const tooltip = FAMILY_STATUS_TEXT[status];
  return (
    <span className="pigui-session-glyph" aria-hidden="true">
      <StatusDot variant={variant} label={tooltip} tooltip={tooltip} isPulsing={status !== "failed"} />
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
        <Icon icon="chevronRight" size="sm" color="inherit" />
      </span>
    </span>
  );
}

/**
 * One root conversation row: forks and subagents never get rows of their own —
 * the row stands for the whole family, so its status dot, recency, and
 * selection all aggregate the node's descendants.
 */
function ConversationRow({
  node,
  shown,
  disabled,
  remote,
  onOpen,
  onSelect,
}: {
  node: ConversationNode;
  shown: ConversationId | undefined;
  disabled: boolean;
  remote: RemoteDurable;
  onOpen: (id: ConversationId) => void;
  onSelect?: () => void;
}) {
  const { summary } = node;
  const status = familyStatus(node);
  // The family's subagents, forks' included — the same set the Tasks tab lists.
  const subagents = taskGroupsOf(node).reduce((total, group) => total + group.tasks.length, 0);
  const [renaming, setRenaming] = useState(false);
  // Selected while the root or any of its descendants is shown.
  const selected = shown !== undefined && flattenNodes([node]).some((each) => each.summary.id === shown);
  const item = (
    <SideNavItem
      icon={status === undefined ? <SessionGlyphSlot /> : <FamilyStatusGlyph status={status} />}
      label={summary.title ?? "New conversation"}
      isSelected={selected}
      isDisabled={disabled}
      // A <button> row cannot contain the interactive … overlay; the spacer
      // reserves its single-button width so the title truncates first, and
      // shows the subagent count until the … takes the slot. Decorative: the
      // row's accessible name stays exactly the title.
      endContent={
        <span aria-hidden="true" className="pigui-sidenav-actions-spacer pigui-sidenav-actions-spacer--single">
          {subagents === 0 ? null : (
            <span className="pigui-sidenav-subagent-count">
              <Bot className="size-3" />
              {subagents}
            </span>
          )}
        </span>
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
      {...(status === undefined ? {} : { "data-status": status })}
    >
      {item}
      {status === undefined ? null : (
        // Not aria-describedby: Astryx SideNavItem drops aria props. A hidden
        // sibling after the button puts the status right after the title in
        // reading order while the button's name stays exactly the title.
        <VisuallyHidden>{FAMILY_STATUS_TEXT[status]}</VisuallyHidden>
      )}
      <HStack className="pigui-sidenav-row-actions pigui-sidenav-hover-actions" gap={0.5} vAlign="center">
        <DropdownMenu
          hasChevron={false}
          button={{
            icon: <MoreHorizontal aria-hidden="true" />,
            isIconOnly: true,
            label: "Conversation actions",
            size: "sm",
            variant: "ghost",
            isDisabled: disabled,
          }}
          items={[
            {
              label: "Rename",
              icon: <Pencil aria-hidden="true" size={16} />,
              onClick: () => setRenaming(true),
            },
            {
              label: "Archive",
              icon: <ArchiveArrowDown aria-hidden="true" size={16} />,
              onClick: () => void remote.controller.archive(summary.id, true),
            },
          ]}
        />
      </HStack>
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
 * inside the desktop SideNav and inside MobileNav on narrow screens.
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
  const { key, label, view, remote } = machine;
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
  const organized = view?.organized;
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
  const row = (node: ConversationNode) =>
    remote === undefined ? null : (
      <ConversationRow
        key={node.summary.id}
        node={node}
        shown={shownId}
        disabled={disabled}
        remote={remote}
        onOpen={onOpen}
        onSelect={onSelect}
      />
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
                isDisabled={disabled}
                onClick={() => start({ kind: "chat" })}
              />
              <IconButton
                icon={<FolderAdd aria-hidden="true" />}
                label={`Add project on ${label}`}
                tooltip="Add project"
                size="sm"
                variant="ghost"
                isDisabled={disabled}
                onClick={() => setAddOpen(true)}
              />
            </>
          }
        />
      </div>
      <VStack id={contentId} gap={0.5}>
        {!expanded ? null : organized === undefined ? (
          <SideNavItem
            icon={<SessionGlyphSlot />}
            label="No conversations available"
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
                  {organized.chats.map(row)}
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
                      conversations.map(row)
                    )}
                  </SideNavItem>
                  <HStack className="pigui-sidenav-row-actions" gap={0.5} vAlign="center">
                    <HStack className="pigui-sidenav-hover-actions" gap={0.5} vAlign="center">
                      <IconButton
                        icon={<Plus aria-hidden="true" />}
                        label={`New conversation in ${project.name}`}
                        size="sm"
                        variant="ghost"
                        isDisabled={disabled}
                        onClick={() => start({ kind: "project", path: project.path })}
                      />
                      <DropdownMenu
                        hasChevron={false}
                        button={{
                          icon: <MoreHorizontal aria-hidden="true" />,
                          isIconOnly: true,
                          label: `Project actions for ${project.name}`,
                          size: "sm",
                          variant: "ghost",
                          isDisabled: disabled,
                        }}
                        items={[
                          {
                            label: "Remove project",
                            icon: <Trash2 aria-hidden="true" size={16} />,
                            onClick: () => setRemoving(project),
                          },
                        ]}
                      />
                    </HStack>
                  </HStack>
                </div>
              );
            })}
          </>
        )}
      </VStack>
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
