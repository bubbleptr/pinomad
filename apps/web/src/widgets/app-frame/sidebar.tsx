import { Avatar } from "@astryxdesign/core/Avatar";
import { Button } from "@astryxdesign/core/Button";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { IconButton } from "@astryxdesign/core/IconButton";
import { SideNavItem, SideNavSection } from "@astryxdesign/core/SideNav";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { ConversationNode, Home, Project } from "@pinomad/protocol/organization.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import type { DurableView } from "@pinomad/protocol/view.ts";
import { familyStatus, taskGroupsOf, type FamilyStatus } from "@pinomad/client/family.ts";
import { useAppUpdate } from "../../entities/app-update/use-app-update.ts";
import { ArchiveArrowDown, Bot, ChevronRight, FolderAdd, FolderClosed, FolderOpenState, MoreHorizontal, Pencil, Plus, Settings, Trash2, UserCircle } from "../../shared/ui/icons.tsx";
import { AnimatedNewChat, AnimatedSidebar } from "../../shared/ui/animated-icons.tsx";
import { AddProjectDialog, RemoveProjectDialog } from "./project-dialogs.tsx";
import { RenameConversationDialog } from "./rename-dialog.tsx";
import { HostsMenu } from "./hosts.tsx";
import { useAccountModel } from "../../entities/account/account-context.tsx";
import { clientDeviceName } from "../../address.ts";

const PROJECT_EXPANDED_KEY = "pinomad.projectSidebar.expanded";

/** Project folds belong to one host: the same path may exist on both. */
const projectExpandedKey = (hostKey: string | undefined): string =>
  hostKey === undefined ? PROJECT_EXPANDED_KEY : `${PROJECT_EXPANDED_KEY}.${hostKey}`;

const readExpandedProjects = (hostKey: string | undefined): Record<string, boolean> => {
  const raw = window.localStorage.getItem(projectExpandedKey(hostKey));
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

const writeExpandedProjects = (hostKey: string | undefined, expanded: Record<string, boolean>): void => {
  window.localStorage.setItem(projectExpandedKey(hostKey), JSON.stringify(expanded));
};

const flattenNodes = (nodes: readonly ConversationNode[]): ConversationNode[] =>
  nodes.flatMap((node) => [node, ...flattenNodes(node.children)]);

function useSidebarSectionExpansion(section: "chats" | "projects") {
  const storageKey = `pinomad.sidebarSection.${section}.expanded`;
  const [expanded, setExpanded] = useState(() =>
    typeof window === "undefined" || window.localStorage.getItem(storageKey) !== "false",
  );
  const contentId = useId();
  const toggle = () => {
    const next = !expanded;
    window.localStorage.setItem(storageKey, String(next));
    setExpanded(next);
  };
  return { expanded, contentId, toggle };
}

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
  onSelect,
}: {
  onOpenSettings: () => void;
  onOpenAccount: () => void;
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
      <HostsMenu />
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
        <ChevronRight
          aria-hidden="true"
          className="pigui-sidenav-section-toggle__chevron"
          data-expanded={expanded ? "true" : "false"}
        />
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



function ProjectExpansionIndicator({ expanded }: { expanded: boolean }) {
  const StateIcon = expanded ? FolderOpenState : FolderClosed;
  return (
    <span
      aria-hidden="true"
      className="pigui-project-expansion-indicator"
      data-expanded={expanded ? "true" : "false"}
    >
      <StateIcon className="pigui-project-expansion-indicator__state" />
      <ChevronRight className="pigui-project-expansion-indicator__chevron" />
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

/**
 * The sidebar's shared content — the "New chat" entry plus the Chats and
 * Projects sections — rendered inside the desktop SideNav and inside MobileNav
 * on narrow screens.
 */
export function SidebarContent({
  view,
  remote,
  hostKey,
  draftingChat,
  shownId,
  onDraft,
  onOpen,
  onSelect,
}: {
  view: DurableView;
  remote: RemoteDurable;
  /** The stored host this tree belongs to; absent for token clients. */
  hostKey?: string;
  draftingChat: boolean;
  shownId: ConversationId | undefined;
  onDraft: (home: Home) => void;
  onOpen: (id: ConversationId) => void;
  onSelect?: () => void;
}) {
  const disabled = view.connection !== "connected";
  const [addOpen, setAddOpen] = useState(false);
  const [removing, setRemoving] = useState<Project>();
  const [expandedProjects, setExpandedProjects] = useState(() => readExpandedProjects(hostKey));
  const chats = useSidebarSectionExpansion("chats");
  const projects = useSidebarSectionExpansion("projects");
  const start = (home: Home): void => {
    onDraft(home);
    onSelect?.();
  };
  const shownProjectPath = useMemo(
    () =>
      shownId === undefined
        ? undefined
        : view.organized.projects.find(({ conversations }) =>
            flattenNodes(conversations).some((node) => node.summary.id === shownId),
          )?.project.path,
    [shownId, view.organized.projects],
  );
  // Keep the shown conversation's project open even if the user folded it.
  useEffect(() => {
    if (shownProjectPath === undefined) return;
    setExpandedProjects((prev) => {
      if (prev[shownProjectPath] !== false) return prev;
      const next = { ...prev, [shownProjectPath]: true };
      writeExpandedProjects(hostKey, next);
      return next;
    });
  }, [hostKey, shownProjectPath]);
  const toggleProject = (path: string): void =>
    setExpandedProjects((prev) => {
      const next = { ...prev, [path]: !(prev[path] ?? true) };
      writeExpandedProjects(hostKey, next);
      return next;
    });

  return (
    <>
      <SideNavSection isHeaderHidden title="New chat">
        <SideNavItem
          icon={<AnimatedNewChat className="size-4" />}
          label="New chat"
          isSelected={draftingChat}
          isDisabled={disabled}
          onClick={() => start({ kind: "chat" })}
        />
      </SideNavSection>
      <SideNavSection isHeaderHidden title="Chats">
        <SidebarSectionHeader
          title="Chats"
          expanded={chats.expanded}
          contentId={chats.contentId}
          onToggle={chats.toggle}
          actions={
            <IconButton
              icon={<Plus aria-hidden="true" />}
              label="New chat without a project"
              tooltip="New chat"
              size="sm"
              variant="ghost"
              isDisabled={disabled}
              onClick={() => start({ kind: "chat" })}
            />
          }
        />
        <VStack id={chats.contentId} gap={0.5}>
          {chats.expanded ? (
            view.organized.chats.length === 0 ? (
              <SideNavItem icon={<SessionGlyphSlot />} isDisabled label="No chats" />
            ) : (
              view.organized.chats.map((node) => (
                <ConversationRow
                  key={node.summary.id}
                  node={node}
                  shown={shownId}
                  disabled={disabled}
                  remote={remote}
                  onOpen={onOpen}
                  onSelect={onSelect}
                />
              ))
            )
          ) : null}
        </VStack>
      </SideNavSection>
      <SideNavSection isHeaderHidden title="Projects">
        <SidebarSectionHeader
          title="Projects"
          expanded={projects.expanded}
          contentId={projects.contentId}
          onToggle={projects.toggle}
          pinnedActions
          actions={
            <IconButton
              icon={<FolderAdd aria-hidden="true" />}
              label="Add project"
              tooltip="Add project"
              size="sm"
              variant="ghost"
              isDisabled={disabled}
              onClick={() => setAddOpen(true)}
            />
          }
        />
        <VStack id={projects.contentId} gap={0.5}>
          {projects.expanded ? (
            view.organized.projects.length === 0 ? (
              <SideNavItem
                icon={<FolderAdd aria-hidden="true" />}
                label="Add project"
                isDisabled={disabled}
                onClick={() => setAddOpen(true)}
              />
            ) : (
              view.organized.projects.map(({ project, conversations }) => {
                const expanded = expandedProjects[project.path] ?? true;
                return (
                  <div key={project.path} className="pigui-sidenav-row-with-actions">
                    <SideNavItem
                      collapsible={{ isCollapsed: !expanded, onCollapsedChange: () => toggleProject(project.path) }}
                      icon={<ProjectExpansionIndicator expanded={expanded} />}
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
                        conversations.map((node) => (
                          <ConversationRow
                            key={node.summary.id}
                            node={node}
                            shown={shownId}
                            disabled={disabled}
                            remote={remote}
                            onOpen={onOpen}
                            onSelect={onSelect}
                          />
                        ))
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
              })
            )
          ) : null}
        </VStack>
      </SideNavSection>
      {addOpen ? (
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
      {removing === undefined ? null : (
        <RemoveProjectDialog project={removing} remote={remote} connected={!disabled} onClose={() => setRemoving(undefined)} />
      )}
    </>
  );
}
