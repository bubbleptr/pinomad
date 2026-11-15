// The sidebar in Inbox mode (ADR-0051 §1): per machine, one row per project
// that opens its intake, then its tasks grouped "waiting for you / in
// progress / queued / done". A task row opens the task's conversation, or
// the queued-task screen while the worker has not taken it yet.
import { cn } from "cn";
import { useMemo } from "react";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { InboxGroupName, InboxTaskState } from "@pinomad/client/inbox.ts";
import type { Project } from "@pinomad/protocol/organization.ts";
import { hostSupportsCall } from "@pinomad/protocol/frames.ts";
import type { InboxTask, ProjectInbox } from "@pinomad/protocol/inbox.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import type { DurableView } from "@pinomad/protocol/view.ts";
import type { InboxTarget } from "../../entities/composer/composer-store.ts";
import { describeTasks, GROUP_LABEL, taskOrigin } from "../../entities/inbox/inbox.ts";
import { TaskDot } from "../../entities/inbox/task-dot.tsx";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../../shared/ui/dropdown-menu.tsx";
import { IconButton } from "../../shared/ui/icon-button.tsx";
import { CancelCircle, Code, FolderClosed, Inbox, MoreHorizontal } from "../../shared/ui/icons.tsx";
import { SegmentedControl, SegmentedControlItem } from "../../shared/ui/segmented-control.tsx";
import { SideNavItem, SideNavSection } from "../../shared/ui/side-nav.tsx";
import { useErrorToast } from "../../shared/ui/toast.tsx";

export type SidebarMode = "coding" | "inbox";

const GROUPS: readonly InboxGroupName[] = ["waiting", "running", "pending", "done"];

/** Coding or Inbox, at the top of the sidebar. */
export function ModeSwitch({ mode, onChange }: { mode: SidebarMode; onChange: (mode: SidebarMode) => void }) {
  return (
    <SegmentedControl aria-label="Sidebar mode" className="mx-1 mb-1" value={mode} onValueChange={(value) => onChange(value as SidebarMode)}>
      <SegmentedControlItem value="coding" aria-label="Coding" className="w-10 [&_svg]:size-4">
        <Code aria-hidden="true" />
      </SegmentedControlItem>
      <SegmentedControlItem value="inbox" aria-label="Inbox" className="w-10 [&_svg]:size-4">
        <Inbox aria-hidden="true" />
      </SegmentedControlItem>
    </SegmentedControl>
  );
}

/** What the Inbox sidebar needs of one machine. */
export interface InboxMachine {
  readonly key: string;
  readonly label: string;
  readonly view?: DurableView;
  readonly remote?: RemoteDurable;
  readonly rejected?: boolean;
}

/**
 * One machine's Inboxes. `shownId` and `target` are this machine's only when
 * it is the focused one: the conversation in main, or the Inbox screen shown
 * in place of one.
 */
export function InboxMachineSection({
  machine,
  shownId,
  target,
  onOpen,
  onTarget,
  onSelect,
}: {
  machine: InboxMachine;
  shownId: ConversationId | undefined;
  target: InboxTarget | undefined;
  onOpen: (id: ConversationId) => void;
  onTarget: (target: InboxTarget) => void;
  onSelect?: (() => void) | undefined;
}) {
  const { label, view, remote, rejected = false } = machine;
  const disabled = view?.connection !== "connected";
  const empty = (text: string) => <SideNavItem icon={<span className="pigui-session-glyph" />} isDisabled label={text} />;
  return (
    <SideNavSection title={label}>
      {rejected || view === undefined ? (
        empty(rejected ? "Not paired" : "Not connected")
      ) : view.inbox === null ? (
        empty(hostSupportsCall(view.host?.protocol.minor ?? 0, "sendToIntake") ? "Loading…" : "This host is too old for the Inbox")
      ) : view.inbox.inboxes.length === 0 ? (
        empty("No projects")
      ) : (
        view.inbox.inboxes.map((inbox) => (
          <ProjectInboxRows
            key={inbox.project}
            inbox={inbox}
            project={view.organized.projects.find((entry) => entry.project.path === inbox.project)?.project}
            view={view}
            remote={remote}
            disabled={disabled}
            shownId={shownId}
            target={target}
            onOpen={(id) => {
              onOpen(id);
              onSelect?.();
            }}
            onTarget={(next) => {
              onTarget(next);
              onSelect?.();
            }}
          />
        ))
      )}
    </SideNavSection>
  );
}

function ProjectInboxRows({
  inbox,
  project,
  view,
  remote,
  disabled,
  shownId,
  target,
  onOpen,
  onTarget,
}: {
  inbox: ProjectInbox;
  project: Project | undefined;
  view: DurableView;
  remote: RemoteDurable | undefined;
  disabled: boolean;
  shownId: ConversationId | undefined;
  target: InboxTarget | undefined;
  onOpen: (id: ConversationId) => void;
  onTarget: (target: InboxTarget) => void;
}) {
  const name = project?.name ?? inbox.project.split("/").at(-1) ?? inbox.project;
  // In group order, the queue in the worker's order.
  const described = useMemo(() => [...describeTasks(inbox, view.organized).values()], [inbox, view.organized]);
  const queued = described.filter((info) => info.group === "pending").length;
  const intakeShown =
    (inbox.intake !== undefined && inbox.intake === shownId) ||
    (shownId === undefined && target?.project === inbox.project && target.task === undefined);
  return (
    <div className="flex flex-col gap-0.5 pb-2">
      <SideNavItem
        icon={<FolderClosed aria-hidden="true" />}
        label={name}
        isSelected={intakeShown}
        isDisabled={disabled && inbox.intake === undefined}
        endContent={
          <span className="text-xs text-muted-foreground">
            {inbox.tasks.length === 0 ? "Empty" : queued > 0 ? `${queued} queued` : null}
          </span>
        }
        onClick={() => (inbox.intake === undefined ? onTarget({ project: inbox.project }) : onOpen(inbox.intake))}
      />
      {GROUPS.map((group) => {
        const tasks = described.filter((info) => info.group === group);
        return tasks.length === 0 ? null : (
          <div key={group} role="group" aria-label={`${name}: ${GROUP_LABEL[group]}`} className="flex flex-col gap-0.5">
            <div aria-hidden="true" className="px-2 pt-2 pb-0.5 text-xs/5 text-muted-foreground select-none">
              {GROUP_LABEL[group]}
            </div>
            {tasks.map(({ task, state, text }) => {
              const selected =
                task.conversationId !== undefined
                  ? task.conversationId === shownId
                  : shownId === undefined && target?.project === inbox.project && target.task === task.id;
              return (
                <InboxTaskRow
                  key={task.id}
                  task={task}
                  state={state}
                  description={`${taskOrigin(task)} · ${text}`}
                  selected={selected}
                  disabled={disabled && task.conversationId === undefined}
                  onOpen={() =>
                    task.conversationId === undefined ? onTarget({ project: inbox.project, task: task.id }) : onOpen(task.conversationId)
                  }
                  onSkip={
                    state === "pending" && remote !== undefined && !disabled
                      ? () => remote.controller.skipInboxTask(inbox.project, task.id)
                      : undefined
                  }
                />
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

/**
 * A task row: its state light, title and a second line saying where it came
 * from and where it stands. Two lines, so not a SideNavItem; it shares that
 * row's surfaces. A queued task's … menu offers Skip.
 */
export function InboxTaskRow({
  task,
  state,
  description,
  selected,
  disabled = false,
  onOpen,
  onSkip,
}: {
  task: InboxTask;
  state: InboxTaskState;
  description: string;
  selected: boolean;
  disabled?: boolean;
  onOpen: () => void;
  /** Present while the task can be skipped (queued, connected). */
  onSkip?: (() => Promise<void>) | undefined;
}) {
  const error = useErrorToast();
  const closed = state === "done" || state === "skipped" || state === "failed";
  return (
    <div className="pigui-sidenav-row-with-actions pigui-sidenav-session-row" data-inbox-state={state}>
      <button
        type="button"
        data-slot="inbox-task-row"
        aria-current={selected ? "page" : undefined}
        disabled={disabled}
        className={cn(
          "flex w-full cursor-pointer items-start gap-2 rounded-(--pigui-sidebar-item-radius) px-2 py-1.5 text-start",
          "not-aria-[current=page]:active:bg-(--surface-pressed) [@media(hover:hover)]:not-aria-[current=page]:hover:bg-surface-hover",
          "aria-[current=page]:bg-default disabled:pointer-events-none disabled:opacity-60",
        )}
        onClick={onOpen}
      >
        <span className="flex h-5 items-center">
          <TaskDot state={state} />
        </span>
        <span className={cn("flex min-w-0 flex-1 flex-col", onSkip !== undefined && "pe-6")}>
          <span className={cn("truncate text-sm/5", state === "waiting" && "font-semibold", closed && "text-muted-foreground")}>
            {task.title}
          </span>
          <span className="truncate text-xs/5 text-muted-foreground">{description}</span>
        </span>
      </button>
      {onSkip === undefined ? null : (
        <div className="flex items-center gap-0.5 pigui-sidenav-row-actions pigui-sidenav-hover-actions">
          <DropdownMenu>
            <DropdownMenuTrigger render={<IconButton icon={<MoreHorizontal aria-hidden="true" />} label={`Task actions for ${task.title}`} size="sm" />} />
            <DropdownMenuContent>
              <DropdownMenuItem
                onClick={() => {
                  error.clear();
                  onSkip().catch((reason: unknown) =>
                    error.show(`Couldn't skip ${task.title}: ${reason instanceof Error ? reason.message : String(reason)}`),
                  );
                }}
              >
                <CancelCircle aria-hidden="true" />
                Skip
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
    </div>
  );
}
