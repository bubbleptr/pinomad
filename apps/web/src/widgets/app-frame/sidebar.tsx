import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { IconButton } from "@astryxdesign/core/IconButton";
import { SideNavItem, SideNavSection } from "@astryxdesign/core/SideNav";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { ConversationNode, Home, Project } from "@pinomad/protocol/organization.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import type { DurableView } from "@pinomad/protocol/view.ts";
import { familyStatus, familyUpdatedAt, relativeTime, type FamilyStatus } from "../../entities/conversation/family.ts";
import { Archive, ChevronRight, Computer, FolderClosed, FolderOpenState, MoreHorizontal, Plus, Trash2 } from "../../shared/ui/icons.tsx";
import { AnimatedNewChat, AnimatedSidebar } from "../../shared/ui/animated-icons.tsx";
import { AddProjectDialog, RemoveProjectDialog } from "./project-dialogs.tsx";

const PROJECT_EXPANDED_KEY = "pinomad.projectSidebar.expanded";

const readExpandedProjects = (): Record<string, boolean> => {
  const raw = window.localStorage.getItem(PROJECT_EXPANDED_KEY);
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

const writeExpandedProjects = (expanded: Record<string, boolean>): void => {
  window.localStorage.setItem(PROJECT_EXPANDED_KEY, JSON.stringify(expanded));
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

export function ConnectionDot({ connection }: { connection: DurableView["connection"] }) {
  return connection === "connected" ? (
    <StatusDot variant="success" label="Connected" tooltip="Connected to the host" />
  ) : (
    <StatusDot variant={connection === "closed" ? "error" : "warning"} label={connection} tooltip={connection} isPulsing />
  );
}

/** The SideNav header band: collapse toggle + connection dot. The slot adds
    8px block padding each side, so 24px of band lands the toggle on the same
    40px center line as the main header (Pace's spacer trick). */
export function SidebarHeaderBand({
  connection,
  onCollapse,
  safeLeft,
}: {
  connection: DurableView["connection"];
  onCollapse?: () => void;
  /** Left inset reserved for the macOS traffic lights when the sidebar owns the corner. */
  safeLeft?: string;
}) {
  return (
    <div
      className="pinomad-drag flex h-6 items-center justify-between px-2"
      style={safeLeft === undefined ? undefined : { paddingLeft: safeLeft }}
    >
      <IconButton
        icon={<AnimatedSidebar className="size-4" />}
        label="Collapse sidebar"
        size="sm"
        variant="ghost"
        onClick={onCollapse}
      />
      <ConnectionDot connection={connection} />
    </div>
  );
}

/** Footer slot: the Devices entry. The dialog itself is hoisted into
    AppFrame — inside MobileNav it would render in the drawer that this click
    just closed. */
export function SidebarFooter({
  view,
  onOpenDevices,
  onSelect,
}: {
  view: DurableView;
  onOpenDevices: () => void;
  onSelect?: () => void;
}) {
  return (
    <SideNavItem
      icon={<Computer aria-hidden="true" />}
      label="Devices"
      isDisabled={view.connection !== "connected"}
      onClick={() => {
        onOpenDevices();
        onSelect?.();
      }}
    />
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
}: {
  title: string;
  expanded: boolean;
  contentId: string;
  onToggle: () => void;
  actions: ReactNode;
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
      <HStack className="pigui-sidenav-hover-actions" gap={0.5} vAlign="center">
        {actions}
      </HStack>
    </div>
  );
}

/** Fixed-size glyph slot so rows with and without status stay aligned. */
function SessionGlyphSlot() {
  return <span className="pigui-session-glyph" data-testid="session-glyph" />;
}

/**
 * The whole family's most urgent status in the glyph slot. The dot
 * is decorative inside the row's <button> — aria-hidden so the accessible name
 * stays exactly the title; the status itself is machine-readable on the row.
 */
function FamilyStatusGlyph({ status }: { status: FamilyStatus }) {
  const variant = status === "needs-answer" ? "warning" : status === "failed" ? "error" : "success";
  const tooltip = status === "needs-answer" ? "Waiting for your answer" : status === "failed" ? "Failed" : "Running";
  return (
    <span className="pigui-session-glyph" aria-hidden="true">
      <StatusDot variant={variant} label={tooltip} tooltip={tooltip} isPulsing={status !== "failed"} />
    </span>
  );
}

/** One shared clock for every row's relative time — not one interval per row. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
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
  now,
  onSelect,
}: {
  node: ConversationNode;
  shown: ConversationId | undefined;
  disabled: boolean;
  remote: RemoteDurable;
  now: number;
  onSelect?: () => void;
}) {
  const { summary } = node;
  const status = familyStatus(node);
  const updatedAt = familyUpdatedAt(node);
  // Selected while the root or any of its descendants is shown.
  const selected = shown !== undefined && flattenNodes([node]).some((each) => each.summary.id === shown);
  const item = (
    <SideNavItem
      icon={status === undefined ? <SessionGlyphSlot /> : <FamilyStatusGlyph status={status} />}
      label={summary.title ?? "New conversation"}
      isSelected={selected}
      isDisabled={disabled}
      // The meta sits before the actions spacer; on hover the row's actions
      // fade it out (the CSS already swaps the two slots).
      endContent={
        <>
          {updatedAt === undefined ? null : (
            // Decorative inside the button, like the dot: the accessible name
            // stays exactly the title (tests match rows by name verbatim).
            <span aria-hidden="true" className="pigui-sidenav-session-meta ms-2 text-xs text-muted">
              {relativeTime(updatedAt, now)}
            </span>
          )}
          <span aria-hidden="true" className="pigui-sidenav-actions-spacer" />
        </>
      }
      onClick={() => {
        void remote.controller.switchConversation(summary.id);
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
              label: "Archive",
              icon: <Archive aria-hidden="true" size={16} />,
              onClick: () => void remote.controller.archive(summary.id, true),
            },
          ]}
        />
      </HStack>
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
  draftingChat,
  shownId,
  onDraft,
  onSelect,
}: {
  view: DurableView;
  remote: RemoteDurable;
  draftingChat: boolean;
  shownId: ConversationId | undefined;
  onDraft: (home: Home) => void;
  onSelect?: () => void;
}) {
  const disabled = view.connection !== "connected";
  const now = useNow(60_000);
  const [addOpen, setAddOpen] = useState(false);
  const [removing, setRemoving] = useState<Project>();
  const [expandedProjects, setExpandedProjects] = useState(readExpandedProjects);
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
      writeExpandedProjects(next);
      return next;
    });
  }, [shownProjectPath]);
  const toggleProject = (path: string): void =>
    setExpandedProjects((prev) => {
      const next = { ...prev, [path]: !(prev[path] ?? true) };
      writeExpandedProjects(next);
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
                  now={now}
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
          actions={
            <IconButton
              icon={<Plus aria-hidden="true" />}
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
                            now={now}
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
          ) : null}
        </VStack>
      </SideNavSection>
      {addOpen ? <AddProjectDialog remote={remote} connected={!disabled} onClose={() => setAddOpen(false)} /> : null}
      {removing === undefined ? null : (
        <RemoveProjectDialog project={removing} remote={remote} connected={!disabled} onClose={() => setRemoving(undefined)} />
      )}
    </>
  );
}
