// The conversation overview (#215): a card floating over the chat column's
// top-right corner, toggled from the header and opened when a conversation
// starts. It summarizes the shown conversation — where it works, what it
// changed, how full its context is and what it spent, which subagents are
// busy, which tool sources are up — and links out for the detail: the
// side panel's Changes and Tasks surfaces. It replaces the side panel's
// Live tab.
import { Fragment, useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { ConversationId } from "@earendil-works/pi-durable";
import { classify } from "@pinomad/protocol/presentation.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import type { DurableView } from "@pinomad/protocol/view.ts";
import { agentOf } from "@pinomad/client/chat.ts";
import { contextUsage } from "@pinomad/client/context-usage.ts";
import { rootOf, taskGroupsOf } from "@pinomad/client/family.ts";
import { conversationName } from "../../entities/conversation/subagent.ts";
import { summaryOf } from "@pinomad/client/model.ts";
import { toolDisplayName } from "@pinomad/client/tool-item.ts";
import { ContextBreakdownList, matchingBreakdown } from "../../entities/conversation/context-breakdown.tsx";
import { ContextBar, ContextHeadline } from "../../entities/conversation/context-meter.tsx";
import { branchOf, ChangeFigure, changeStatOf, type ChangeStat } from "../../entities/conversation/change-stat.tsx";
import { taskTally } from "../../entities/conversation/task-tally.ts";
import { subagentTone, TaskGlyph } from "../../entities/conversation/task-glyph.tsx";
import { ProcessDuration, processShortText, processTone } from "../../entities/process/process-status.tsx";
import { useProcessList } from "../../entities/process/use-process-list.ts";
import { isProcessActive, type ProcessInfo } from "@pinomad/protocol/processes.ts";
import type { ConversationSummary } from "@pinomad/protocol/view.ts";
import { DocumentView } from "../../presentation/documents.tsx";
import { DisclosureButton, DisclosureChevron } from "../../shared/ui/disclosure-button.tsx";
import { ChevronRight, FileDiff, FolderClosed, FolderGitTwo, GitBranch } from "../../shared/ui/icons.tsx";
import { StatusDot } from "../../shared/ui/status-dot.tsx";

/** Tasks at work listed by name before the rest fold into the summary line. */
const ACTIVE_ROWS = 4;
/** Finished tasks listed while nothing is at work. */
const ENDED_ROWS = 3;

/**
 * The checkout's +N −M against its base — and, on a 5.11 host, the
 * checkout's live branch (`branch` is undefined for detached HEAD and
 * non-git directories). Fetched when the card mounts, when the conversation
 * changes, whenever a run settles, and when the connection comes back — the
 * moments the number or the branch can move or a failed ask can succeed.
 * Opening during a run still fetches once; streaming updates don't poll.
 * A stale answer from a previous conversation is dropped.
 */
function useChangeStat(
  remote: RemoteDurable,
  conversationId: ConversationId,
  busy: boolean,
  connected: boolean,
  enabled: boolean,
): ChangeStat {
  const [stat, setStat] = useState<ChangeStat>({ kind: "loading" });
  const latest = useRef(0);
  const refresh = useCallback(() => {
    const request = ++latest.current;
    remote.controller.changes().then(
      (result) => {
        if (request === latest.current) setStat(changeStatOf(result));
      },
      // A failed ask is not "no repository": keep the row so the panel stays reachable.
      () => {
        if (request === latest.current) setStat({ kind: "failed" });
      },
    );
  }, [remote]);
  useEffect(() => setStat({ kind: "loading" }), [conversationId]);
  useEffect(() => {
    if (enabled && connected) refresh();
    return () => {
      latest.current++;
    };
  }, [refresh, conversationId, connected, enabled]);
  const wasBusy = useRef(busy);
  useEffect(() => {
    if (wasBusy.current && !busy && enabled && connected) refresh();
    wasBusy.current = busy;
  }, [busy, enabled, connected, refresh]);
  return stat;
}

type SectionKey = "workspace" | "usage" | "tasks" | "sources";

const COLLAPSED_KEY = "pinomad.overview.collapsed";

function readCollapsed(): Partial<Record<SectionKey, boolean>> {
  try {
    return JSON.parse(window.localStorage.getItem(COLLAPSED_KEY) ?? "{}") as Partial<Record<SectionKey, boolean>>;
  } catch {
    return {};
  }
}

const CARD = "flex shrink-0 flex-col gap-0.5 rounded-[var(--radius-element)] border border-[var(--border)] bg-[var(--popover)] px-2.5";

/**
 * One section card. A titled one folds its rows away under its header — the
 * whole row is the button — and the header then carries `summary`, so a
 * folded section still says how it's doing. Which sections are folded
 * survives reloads. Only the chevron turns: the rows show and hide at once,
 * so the cards below never animate layout, and they fade in only after a
 * toggle, never when the card opens.
 */
function Section({ section, title, summary, children }: { section: SectionKey; title: string; summary?: ReactNode; children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(() => readCollapsed()[section] === true);
  const [toggled, setToggled] = useState(false);
  const body = useId();
  const heading = useId();
  const toggle = () => {
    window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify({ ...readCollapsed(), [section]: !collapsed }));
    setCollapsed(!collapsed);
    setToggled(true);
  };
  return (
    <section aria-labelledby={heading} className={`${CARD} pt-1 ${collapsed ? "pb-1" : "pb-1.5"}`}>
      <h2 className="-mx-1.5">
        <DisclosureButton
          open={!collapsed}
          aria-controls={body}
          className="flex h-7 w-full items-center gap-2 rounded-md px-1.5 text-xs font-medium text-muted-foreground hover:bg-surface-hover hover:text-foreground"
          onClick={toggle}
        >
          <span id={heading} className="shrink-0">{title}</span>
          <span className="min-w-0 flex-1 truncate text-end font-normal tabular-nums">{collapsed ? summary : null}</span>
          <DisclosureChevron />
        </DisclosureButton>
      </h2>
      <div id={body} hidden={collapsed} className={`flex flex-col gap-0.5 ${toggled ? "motion-safe:animate-[pigui-overview-reveal_150ms_ease-out]" : ""}`}>
        {children}
      </div>
    </section>
  );
}

/**
 * One line: icon, text that truncates, optional trailing content. A button
 * when it leads somewhere. A `null` icon keeps the slot (the text lines up
 * with its iconed siblings); an absent one drops it. `iconLabel` names an
 * icon that carries meaning the text doesn't repeat.
 */
function Row({
  icon,
  iconLabel,
  children,
  end,
  title,
  onClick,
}: {
  icon?: ReactNode;
  iconLabel?: string;
  children: ReactNode;
  end?: ReactNode;
  title?: string;
  onClick?: () => void;
}) {
  const content = (
    <>
      {icon === undefined ? null : (
        <span
          {...(iconLabel === undefined ? { "aria-hidden": true } : { role: "img", "aria-label": iconLabel })}
          className="flex size-4 shrink-0 items-center justify-center text-muted-foreground"
        >
          {icon}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate text-start">{children}</span>
      {end === undefined ? null : <span className="shrink-0 tabular-nums">{end}</span>}
    </>
  );
  const className = "-mx-1.5 flex h-8 items-center gap-2.5 rounded-md px-1.5 text-sm";
  return onClick === undefined ? (
    <div className={className} title={title}>
      {content}
    </div>
  ) : (
    <button type="button" className={`${className} hover:bg-surface-hover focus-visible:bg-surface-hover`} title={title} onClick={onClick}>
      {content}
    </button>
  );
}

function WorkspaceSection({
  view,
  remote,
  conversation,
  busy,
  onOpenChanges,
}: {
  view: DurableView;
  remote: RemoteDurable;
  conversation: NonNullable<DurableView["conversation"]>;
  busy: boolean;
  onOpenChanges: () => void;
}) {
  const cwd = agentOf(conversation).cwd;
  const home = view.home;
  const isChat = home?.kind === "chat";
  const worktree = view.checkout !== undefined;
  // A worktree's own folder is named for the conversation, so a project row
  // names the project; a chat's folder has nothing better to show.
  const folderName =
    home?.kind === "project"
      ? (view.organized.projects.find((entry) => entry.project.path === home.path)?.project.name ?? home.path.split("/").at(-1))
      : isChat
        ? "Chat folder"
        : cwd?.split("/").at(-1);
  // The name already says which folder, so the path after it stops at the
  // parent; a chat's folder has no name of its own and keeps its full path.
  const folderPath = home?.kind === "project" ? parentOf(home.path) : isChat ? cwd : cwd === undefined ? undefined : parentOf(cwd);
  const stat = useChangeStat(remote, conversation.conversation.id, busy, view.connection === "connected", !isChat);
  const branch = branchOf(view, stat);
  return (
    <Section
      section="workspace"
      title="Workspace"
      summary={hasChanges(stat) ? <ChangeFigure stat={stat} /> : branch}
    >
      {cwd === undefined ? null : (
        <Row
          icon={worktree ? <FolderGitTwo className="size-4" /> : <FolderClosed className="size-4" />}
          iconLabel={isChat ? undefined : worktree ? "Git worktree" : "Project folder"}
          title={cwd}
        >
          <span className="flex items-center gap-3">
            <span className="min-w-0 truncate">{folderName}</span>
            {/* A path's tail says where it is: an rtl box clips from the left,
                and the LRM keeps the leading "/" from flipping to the end. */}
            <span className="min-w-0 flex-1 truncate text-right text-muted-foreground [direction:rtl]">{`\u200E${folderPath}`}</span>
          </span>
        </Row>
      )}
      {branch === undefined ? null : (
        <Row
          icon={<GitBranch className="size-4" />}
          end={worktree ? <span className="text-xs text-muted-foreground">Worktree</span> : undefined}
        >
          {branch}
        </Row>
      )}
      {isChat || !hasChanges(stat) ? null : <ChangesRow stat={stat} onOpen={onOpenChanges} />}
    </Section>
  );
}

const parentOf = (path: string): string => path.slice(0, path.lastIndexOf("/")) || "/";

/** Only a checkout with something in it gets a Changes row; a clean one has nothing to open. */
const hasChanges = (stat: ChangeStat): stat is Extract<ChangeStat, { kind: "ready" }> => stat.kind === "ready" && stat.files > 0;

function ChangesRow({ stat, onOpen }: { stat: Extract<ChangeStat, { kind: "ready" }>; onOpen: () => void }) {
  return (
    <Row icon={<FileDiff className="size-4" />} end={<ChangeFigure stat={stat} />} onClick={onOpen}>
      Changes
    </Row>
  );
}

/** How full the context window is, against the shown model. */
function UsageSection({ view, conversation }: { view: DurableView; conversation: NonNullable<DurableView["conversation"]> }) {
  const model = summaryOf(view.models, agentOf(conversation).model);
  const usage = contextUsage(conversation, model?.contextWindow);
  const breakdown = matchingBreakdown(view.docs, usage);
  const percent = usage === undefined ? "—" : `${Math.round((usage.used / usage.window) * 100)}%`;
  return (
    <Section section="usage" title="Context" summary={percent}>
      <ContextHeadline usage={usage} />
      <div className="pb-1.5">
        <ContextBar usage={usage} breakdown={breakdown} />
      </div>
      {usage === undefined ? null : <ContextBreakdownList usage={usage} breakdown={breakdown} />}
    </Section>
  );
}

/** One Tasks row: a subagent or a background process, with what it is doing or how it ended. */
type TaskRow =
  | { kind: "subagent"; task: ConversationSummary }
  | { kind: "process"; process: ProcessInfo };

/** "2 more running · 2 done · 1 failed", the failures in red; nothing when there is nothing to add. */
function tallyLine(more: number, done: number, failed: number): ReactNode {
  const parts: ReactNode[] = [];
  if (more > 0) parts.push(`${more} more running`);
  if (done > 0) parts.push(`${done} done`);
  if (failed > 0) parts.push(<span key="failed" className="text-destructive">{`${failed} failed`}</span>);
  if (parts.length === 0) return undefined;
  return parts.flatMap((part, index) => (index === 0 ? [part] : [" · ", part]));
}

function TaskRowView({ row, onOpenTasks }: { row: TaskRow; onOpenTasks: (id?: ConversationId) => void }) {
  if (row.kind === "process") {
    const { process } = row;
    const tone = processTone(process.state);
    return (
      <Row
        icon={<TaskGlyph kind="process" tone={tone} />}
        iconLabel={`Process, ${processShortText(process.state)}`}
        end={
          <span className={`text-xs ${tone === "failed" ? "text-destructive" : "text-muted-foreground"}`}>
            {isProcessActive(process.state) ? <ProcessDuration startedAt={process.startedAt} /> : processShortText(process.state)}
          </span>
        }
        onClick={() => onOpenTasks()}
      >
        {process.name}
      </Row>
    );
  }
  const { task } = row;
  const tone = subagentTone(task.status);
  const state =
    task.status === "needs-answer"
      ? "waiting"
      : task.status === "running"
        ? task.activity === undefined
          ? undefined
          : (toolDisplayName(task.activity.tool) ?? task.activity.tool)
        : tone === "failed"
          ? "Failed"
          : "Done";
  return (
    <Row
      icon={<TaskGlyph kind="subagent" tone={tone} />}
      iconLabel={`Subagent, ${task.status === "needs-answer" ? "waiting for an answer" : tone}`}
      end={state === undefined ? undefined : <span className={`text-xs ${tone === "failed" ? "text-destructive" : "text-muted-foreground"}`}>{state}</span>}
      onClick={() => onOpenTasks(task.id)}
    >
      {conversationName(task)}
    </Row>
  );
}

/**
 * The family's subagents and background processes: the ones at work by name
 * (subagents first), or the latest subagents to finish while nothing is at
 * work, then a line into the side panel's Tasks list.
 */
function TasksSection({
  view,
  remote,
  conversation,
  onOpenTasks,
}: {
  view: DurableView;
  remote: RemoteDurable;
  conversation: NonNullable<DurableView["conversation"]>;
  onOpenTasks: (id?: ConversationId) => void;
}) {
  const root = rootOf(view.organized, conversation.conversation.id);
  // The list belongs to the family root, so a shown fork reads the root's copy.
  const processes = useProcessList(remote.processes, root?.summary.id)?.processes ?? [];
  const tasks = root === undefined ? [] : taskGroupsOf(root).flatMap((group) => group.tasks.map((node) => node.summary));
  if (tasks.length === 0 && processes.length === 0) return null;
  const { active, done, failed } = taskTally(tasks);
  const live: TaskRow[] = [
    ...active.map((task) => ({ kind: "subagent" as const, task })),
    ...processes.filter((process) => isProcessActive(process.state)).map((process) => ({ kind: "process" as const, process })),
  ];
  // Only subagents: ended processes (a lost one never ages out) stay in the
  // Tasks list rather than crowding out the family's finished work.
  const ended: TaskRow[] = tasks
    .filter((task) => subagentTone(task.status) !== "running")
    .sort((a, b) => Number(b.status === "failed") - Number(a.status === "failed") || (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .map((task) => ({ kind: "subagent" as const, task }));
  const rows = live.length > 0 ? live.slice(0, ACTIVE_ROWS) : ended.slice(0, ENDED_ROWS);
  const tally = tallyLine(live.length - rows.length, done, failed);
  const footer = live.length > 0 ? tally : "All tasks";
  return (
    <Section section="tasks" title="Tasks" summary={live.length > 0 ? `${live.length} running` : tally}>
      {rows.map((row) => (
        <TaskRowView key={row.kind === "subagent" ? `s${row.task.id}` : `p${row.process.id}`} row={row} onOpenTasks={onOpenTasks} />
      ))}
      {footer === undefined ? null : (
        <Row icon={null} end={<ChevronRight aria-hidden="true" className="size-4 text-muted-foreground" />} onClick={() => onOpenTasks()}>
          <span className="text-muted-foreground">{footer}</span>
        </Row>
      )}
    </Section>
  );
}

const MCP_VARIANT = { connecting: "warning", connected: "success", failed: "error", disabled: "neutral" } as const;

/** An MCP error in full: it is what the user needs to fix the config. */
function SourceProblem({ children, inline = false }: { children: string; inline?: boolean }) {
  return <p className={`m-0 text-xs/5 break-words text-destructive ${inline ? "min-w-0 flex-1" : "-mt-1 mb-1 ps-6.5"}`}>{children}</p>;
}

/** The host's MCP servers (ADR-0012); hidden when MCP is off or unconfigured. */
function SourcesSection({ view }: { view: DurableView }) {
  const mcp = view.mcp;
  if (mcp === null || (mcp.servers.length === 0 && mcp.errors.length === 0)) return null;
  const problems = mcp.servers.filter((server) => server.state === "failed").length + mcp.errors.length;
  const connected = mcp.servers.filter((server) => server.state === "connected").length;
  return (
    <Section
      section="sources"
      title="Sources"
      summary={
        problems > 0 ? (
          <span className="text-destructive">
            {problems} problem{problems === 1 ? "" : "s"}
          </span>
        ) : (
          `${connected} connected`
        )
      }
    >
      {mcp.servers.map((server) => (
        <Fragment key={server.name}>
          <Row
            icon={<StatusDot variant={MCP_VARIANT[server.state]} label={server.state} pulsing={server.state === "connecting"} />}
            end={
              <span className="text-xs text-muted-foreground">
                {server.state === "connected" ? `${server.tools} tool${server.tools === 1 ? "" : "s"}` : server.state}
              </span>
            }
          >
            {server.name}
          </Row>
          {server.error === undefined ? null : <SourceProblem>{server.error}</SourceProblem>}
        </Fragment>
      ))}
      {mcp.errors.map((error, index) => (
        <div key={index} className="flex items-start gap-2.5 py-1.5">
          <span className="flex h-5 w-4 shrink-0 items-center justify-center">
            <StatusDot variant="error" label="config error" />
          </span>
          <SourceProblem inline>{error}</SourceProblem>
        </div>
      ))}
    </Section>
  );
}

/**
 * Extension documents the transcript does not already show: the todo list
 * has its card under the run, questions sit above the composer, and the
 * context breakdown belongs to the Context section, so only other kinds —
 * including a malformed todo, inspected through the fallback — land here.
 */
function DocumentsSection({ view, remote }: { view: DurableView; remote: RemoteDurable }) {
  const docs = view.docs.filter((doc) => {
    // A plugin's shared state is its own UI's to show (ADR-0049).
    if (doc.value === null || doc.kind.startsWith("plugin.")) return false;
    const type = classify(doc.presentation, doc.value).type;
    return type !== "pinomad.todo" && type !== "pinomad.question" && type !== "pinomad.context";
  });
  if (docs.length === 0) return null;
  return (
    <>
      {docs.map((doc) => (
        <section key={doc.kind} className={`${CARD} py-2`}>
          <DocumentView doc={doc} remote={remote} connected={view.connection === "connected"} />
        </section>
      ))}
    </>
  );
}

export function OverviewCard({
  view,
  remote,
  conversation,
  narrow,
  busy,
  onOpenChanges,
  onOpenTasks,
  onClose,
  entering = false,
  onEntered,
}: {
  view: DurableView;
  remote: RemoteDurable;
  conversation: NonNullable<DurableView["conversation"]>;
  /** Wide layouts keep the card slim so the chat column can clear it; a phone has no room to clear, so it may cover. */
  narrow: boolean;
  busy: boolean;
  onOpenChanges: () => void;
  /** Opens the side panel's Tasks list, on a subagent's detail when one is given. */
  onOpenTasks: (id?: ConversationId) => void;
  onClose: () => void;
  /** Plays the entrance once, then `onEntered` clears it. */
  entering?: boolean;
  onEntered?: () => void;
}) {
  return (
    <aside
      aria-label="Overview"
      // A bare stack of bordered section cards, no tray behind them.
      className={`absolute end-3 top-3 z-20 flex max-h-[calc(100%-1.5rem)] ${narrow ? "w-[min(20rem,calc(100%-1.5rem))]" : "w-[var(--pigui-overview-width)]"} flex-col gap-1.5 overflow-y-auto ${entering ? "motion-safe:animate-[pigui-overview-enter_200ms_ease-out]" : ""}`}
      onAnimationEnd={(event) => {
        // The sections' own reveals bubble up here too.
        if (event.target === event.currentTarget) onEntered?.();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        onClose();
      }}
    >
      <WorkspaceSection view={view} remote={remote} conversation={conversation} busy={busy} onOpenChanges={onOpenChanges} />
      <UsageSection view={view} conversation={conversation} />
      <TasksSection view={view} remote={remote} conversation={conversation} onOpenTasks={onOpenTasks} />
      <SourcesSection view={view} />
      <DocumentsSection view={view} remote={remote} />
    </aside>
  );
}
