// The conversation overview (#215): a card floating over the chat column's
// top-right corner, toggled from the header and opened when a conversation
// starts. It summarizes the shown conversation — where it works, what it
// changed, how full its context is and what it spent, which subagents are
// busy, which tool sources are up — and links out for the detail: the
// Changes dialog, the side panel's Tasks tab. It replaces the side panel's
// Live tab.
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { ConversationId } from "@earendil-works/pi-durable";
import { hostSupportsFeature } from "@pinomad/protocol/frames.ts";
import { classify } from "@pinomad/protocol/presentation.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import type { ConversationSummary, DurableView } from "@pinomad/protocol/view.ts";
import { agentOf, usageRows } from "@pinomad/client/chat.ts";
import { contextUsage } from "@pinomad/client/context-usage.ts";
import { displayName, rootOf, taskGroupsOf } from "@pinomad/client/family.ts";
import { parsePatch } from "@pinomad/client/patch.ts";
import { summaryOf } from "@pinomad/client/model.ts";
import { toolDisplayName } from "@pinomad/client/tool-item.ts";
import { ContextMeter, formatCost } from "../../entities/conversation/context-meter.tsx";
import { DocumentView } from "../../presentation/documents.tsx";
import { ChevronRight, FileDiff, FolderClosed, FolderGitTwo, GitBranch } from "../../shared/ui/icons.tsx";

/** Running subagents listed by name before the rest fold into the summary line. */
const ACTIVE_ROWS = 3;

type ChangeStat =
  | { readonly kind: "loading" }
  | { readonly kind: "unavailable"; readonly branch?: string }
  | { readonly kind: "failed" }
  | {
      readonly kind: "ready";
      readonly files: number;
      readonly additions: number;
      readonly deletions: number;
      readonly truncated: boolean;
      readonly branch?: string;
    };

/**
 * The checkout's +N −M against its base — and, on a 5.11 host, the
 * checkout's live branch (`branch` is undefined for detached HEAD and
 * non-git directories). Fetched when the card mounts, when the conversation
 * changes, whenever a run settles, and when the connection comes back — the
 * moments the number or the branch can move or a failed ask can succeed —
 * never while a run streams edits. A stale answer from a previous
 * conversation is dropped.
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
  useEffect(() => {
    if (!enabled || busy || !connected) return;
    const request = ++latest.current;
    remote.controller.changes().then(
      (result) => {
        if (request !== latest.current) return;
        if (!result.available) return setStat({ kind: "unavailable", branch: result.branch });
        const files = parsePatch(result.patch);
        setStat({
          kind: "ready",
          files: files.length,
          additions: files.reduce((sum, file) => sum + file.additions, 0),
          deletions: files.reduce((sum, file) => sum + file.deletions, 0),
          truncated: result.truncated,
          branch: result.branch,
        });
      },
      // A failed ask is not "no repository": keep the row so the dialog stays reachable.
      () => {
        if (request === latest.current) setStat({ kind: "failed" });
      },
    );
  }, [remote, conversationId, busy, connected, enabled]);
  useEffect(() => setStat({ kind: "loading" }), [conversationId]);
  return stat;
}

const count = (value: number): string => value.toLocaleString("en-US");

type SectionKey = "workspace" | "usage" | "subagents" | "sources";

const COLLAPSED_KEY = "pinomad.overview.collapsed";

function readCollapsed(): Partial<Record<SectionKey, boolean>> {
  try {
    return JSON.parse(window.localStorage.getItem(COLLAPSED_KEY) ?? "{}") as Partial<Record<SectionKey, boolean>>;
  } catch {
    return {};
  }
}

const CARD = "flex shrink-0 flex-col gap-0.5 rounded-[var(--radius-element)] bg-[var(--color-background-popover)] px-2.5 shadow-[var(--pigui-overview-card-elevation)]";

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
  const toggle = () => {
    window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify({ ...readCollapsed(), [section]: !collapsed }));
    setCollapsed(!collapsed);
    setToggled(true);
  };
  return (
    <section className={`${CARD} pt-1 ${collapsed ? "pb-1" : "pb-1.5"}`}>
      <h2 className="-mx-1.5">
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-controls={body}
          className="flex h-7 w-full items-center gap-2 rounded-md px-1.5 text-xs font-medium text-muted hover:bg-surface-hover hover:text-foreground focus-visible:bg-surface-hover"
          onClick={toggle}
        >
          <span className="shrink-0">{title}</span>
          <span className="min-w-0 flex-1 truncate text-end font-normal tabular-nums">{collapsed ? summary : null}</span>
          <ChevronRight
            aria-hidden
            className={`size-3.5 shrink-0 motion-safe:transition-transform motion-safe:duration-150 motion-safe:ease-out ${collapsed ? "" : "rotate-90"}`}
          />
        </button>
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
          className="flex size-4 shrink-0 items-center justify-center text-muted"
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
  const stat = useChangeStat(remote, conversation.conversation.id, busy, view.connection === "connected", !isChat);
  // A 5.11 host reports HEAD's branch with changes() — live, so a worktree
  // that went detached shows nothing instead of the recorded name. Older
  // hosts only know the checkout record's branch.
  const minor = view.host?.protocol.minor;
  const branch =
    minor !== undefined && hostSupportsFeature(minor, "liveBranch")
      ? stat.kind === "ready" || stat.kind === "unavailable"
        ? stat.branch
        : undefined
      : view.checkout?.branch;
  return (
    <Section
      section="workspace"
      title="Workspace"
      summary={isChat || stat.kind === "unavailable" ? branch : <ChangeFigure stat={stat} />}
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
            <span className="min-w-0 flex-1 truncate text-right text-muted [direction:rtl]">{`\u200E${cwd}`}</span>
          </span>
        </Row>
      )}
      {branch === undefined ? null : <Row icon={<GitBranch className="size-4" />}>{branch}</Row>}
      {isChat ? null : <ChangesRow stat={stat} onOpen={onOpenChanges} />}
    </Section>
  );
}

/** The checkout's +N −M, or why there isn't one yet. */
function ChangeFigure({ stat }: { stat: Exclude<ChangeStat, { kind: "unavailable" }> }) {
  return stat.kind === "loading" ? (
    <span className="text-muted">…</span>
  ) : stat.kind === "failed" ? (
    <span className="text-muted">—</span>
  ) : stat.files === 0 ? (
    <span className="text-muted">None</span>
  ) : stat.additions === 0 && stat.deletions === 0 ? (
    // Binary edits, renames and mode changes touch files without text lines.
    <span className="text-muted">
      {stat.files} file{stat.files === 1 ? "" : "s"}
    </span>
  ) : (
    // A truncated patch undercounts: "+" marks the numbers as a floor.
    <span aria-label={`${count(stat.additions)} added, ${count(stat.deletions)} removed${stat.truncated ? " at least" : ""}`}>
      <span className="text-success">+{count(stat.additions)}{stat.truncated ? "+" : ""}</span>{" "}
      <span className="text-danger">−{count(stat.deletions)}{stat.truncated ? "+" : ""}</span>
    </span>
  );
}

function ChangesRow({ stat, onOpen }: { stat: ChangeStat; onOpen: () => void }) {
  if (stat.kind === "unavailable") return null;
  return (
    <Row icon={<FileDiff className="size-4" />} end={<ChangeFigure stat={stat} />} onClick={onOpen}>
      Changes
    </Row>
  );
}

/** How full the context window is, against the shown model, and what the conversation has spent. */
function UsageSection({ view, conversation }: { view: DurableView; conversation: NonNullable<DurableView["conversation"]> }) {
  const model = summaryOf(view.models, agentOf(conversation).model);
  const usage = contextUsage(conversation, model?.contextWindow);
  const spent = usageRows(conversation).reduce((sum, row) => sum + row.cost, 0);
  const percent = usage === undefined ? "—" : `${Math.round((usage.used / usage.window) * 100)}%`;
  return (
    <Section section="usage" title="Usage" summary={spent > 0 ? `${percent} · ${formatCost(spent)}` : percent}>
      <Row end={<ContextMeter usage={usage} />}>Context</Row>
      {spent > 0 ? <Row end={<span className="text-muted">{formatCost(spent)}</span>}>Spent</Row> : null}
    </Section>
  );
}

const ACTIVE_STATUS = new Set<ConversationSummary["status"]>(["running", "needs-answer"]);

function SubagentsSection({
  view,
  conversation,
  onOpenTasks,
}: {
  view: DurableView;
  conversation: NonNullable<DurableView["conversation"]>;
  onOpenTasks: (id?: ConversationId) => void;
}) {
  const root = rootOf(view.organized, conversation.conversation.id);
  const tasks = root === undefined ? [] : taskGroupsOf(root).flatMap((group) => group.tasks.map((node) => node.summary));
  if (tasks.length === 0) return null;
  const active = tasks.filter((task) => ACTIVE_STATUS.has(task.status));
  const failed = tasks.filter((task) => task.status === "failed").length;
  const done = tasks.length - active.length - failed;
  const hidden = active.length - ACTIVE_ROWS;
  const summary = [
    hidden > 0 ? `${hidden} more running` : undefined,
    done > 0 ? `${done} done` : undefined,
    failed > 0 ? `${failed} failed` : undefined,
  ].filter((part) => part !== undefined);
  return (
    <Section section="subagents" title="Subagents" summary={active.length > 0 ? `${active.length} running` : summary.join(" · ")}>
      {active.slice(0, ACTIVE_ROWS).map((task) => (
        <Row
          key={task.id}
          icon={
            <StatusDot
              variant={task.status === "needs-answer" ? "warning" : "success"}
              label={task.status === "needs-answer" ? "Waiting for your answer" : "Running"}
              isPulsing
            />
          }
          end={
            task.activity === undefined ? undefined : (
              <span className="text-xs text-muted">{toolDisplayName(task.activity.tool) ?? task.activity.tool}</span>
            )
          }
          onClick={() => onOpenTasks(task.id)}
        >
          {displayName(task)}
        </Row>
      ))}
      {summary.length === 0 ? null : (
        <Row icon={null} onClick={() => onOpenTasks()}>
          <span className="text-muted">{summary.join(" · ")}</span>
        </Row>
      )}
    </Section>
  );
}

const MCP_VARIANT = { connecting: "warning", connected: "success", failed: "error", disabled: "neutral" } as const;

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
          <span className="text-danger">
            {problems} problem{problems === 1 ? "" : "s"}
          </span>
        ) : (
          `${connected} connected`
        )
      }
    >
      {mcp.servers.map((server) => (
        <Row
          key={server.name}
          icon={<StatusDot variant={MCP_VARIANT[server.state]} label={server.state} isPulsing={server.state === "connecting"} />}
          title={server.error}
          end={
            <span className="text-xs text-muted">
              {server.state === "connected" ? `${server.tools} tool${server.tools === 1 ? "" : "s"}` : server.state}
            </span>
          }
        >
          {server.name}
        </Row>
      ))}
      {mcp.errors.map((error, index) => (
        <Row key={index} icon={<StatusDot variant="error" label="config error" />} title={error}>
          <span className="text-danger">{error}</span>
        </Row>
      ))}
    </Section>
  );
}

/**
 * Extension documents the transcript does not already show: the todo list
 * has its card under the run and questions sit above the composer, so only
 * other kinds — including a malformed todo, inspected through the fallback —
 * land here.
 */
function DocumentsSection({ view, remote }: { view: DurableView; remote: RemoteDurable }) {
  const docs = view.docs.filter((doc) => {
    if (doc.value === null) return false;
    const type = classify(doc.presentation, doc.value).type;
    return type !== "pinomad.todo" && type !== "pinomad.question";
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
}: {
  view: DurableView;
  remote: RemoteDurable;
  conversation: NonNullable<DurableView["conversation"]>;
  /** Wide layouts keep the card slim so the chat column can clear it; a phone has no room to clear, so it may cover. */
  narrow: boolean;
  busy: boolean;
  onOpenChanges: () => void;
  /** Opens the side panel's Tasks tab, on a subagent's detail when one is given. */
  onOpenTasks: (id?: ConversationId) => void;
  onClose: () => void;
}) {
  return (
    <aside
      aria-label="Overview"
      // A grey tray of section cards; its radius is the cards' plus its
      // padding, so the corners stay concentric.
      className={`pigui-overview absolute end-3 top-3 z-20 flex max-h-[calc(100%-1.5rem)] ${narrow ? "w-[min(20rem,calc(100%-1.5rem))]" : "w-[var(--pigui-overview-width)]"} flex-col gap-[var(--pigui-overview-gap)] overflow-y-auto rounded-[calc(var(--radius-element)+var(--pigui-overview-gap))] bg-[var(--color-background-muted)] p-[var(--pigui-overview-gap)] shadow-[var(--pigui-overview-elevation)]`}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        onClose();
      }}
    >
      <WorkspaceSection view={view} remote={remote} conversation={conversation} busy={busy} onOpenChanges={onOpenChanges} />
      <UsageSection view={view} conversation={conversation} />
      <SubagentsSection view={view} conversation={conversation} onOpenTasks={onOpenTasks} />
      <SourcesSection view={view} />
      <DocumentsSection view={view} remote={remote} />
    </aside>
  );
}
