// The conversation overview (#215): a card floating over the chat column's
// top-right corner, toggled from the header. It summarizes the shown
// conversation — where it works, what it changed, which subagents are busy,
// which tool sources are up — and links out for the detail: the Changes
// dialog, the side panel's Tasks tab. It replaces the side panel's Live tab.
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ConversationId } from "@earendil-works/pi-durable";
import { classify } from "@pinomad/protocol/presentation.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import type { ConversationSummary, DurableView } from "@pinomad/protocol/view.ts";
import { agentOf } from "@pinomad/client/chat.ts";
import { displayName, rootOf, taskGroupsOf } from "@pinomad/client/family.ts";
import { parsePatch } from "@pinomad/client/patch.ts";
import { toolDisplayName } from "@pinomad/client/tool-item.ts";
import { DocumentView } from "../../presentation/documents.tsx";
import { FileDiff, FolderClosed, GitBranch } from "../../shared/ui/icons.tsx";

/** Running subagents listed by name before the rest fold into the summary line. */
const ACTIVE_ROWS = 3;

type ChangeStat =
  | { readonly kind: "loading" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "failed" }
  | {
      readonly kind: "ready";
      readonly files: number;
      readonly additions: number;
      readonly deletions: number;
      readonly truncated: boolean;
    };

/**
 * The checkout's +N −M against its base. Fetched when the card mounts, when
 * the conversation changes, whenever a run settles, and when the connection
 * comes back — the moments the number can move or a failed ask can succeed —
 * never while a run streams edits. A stale answer from a previous
 * conversation is dropped.
 */
function useChangeStat(remote: RemoteDurable, conversationId: ConversationId, busy: boolean, connected: boolean): ChangeStat {
  const [stat, setStat] = useState<ChangeStat>({ kind: "loading" });
  const latest = useRef(0);
  useEffect(() => {
    if (busy || !connected) return;
    const request = ++latest.current;
    remote.controller.changes().then(
      (result) => {
        if (request !== latest.current) return;
        if (!result.available) return setStat({ kind: "unavailable" });
        const files = parsePatch(result.patch);
        setStat({
          kind: "ready",
          files: files.length,
          additions: files.reduce((sum, file) => sum + file.additions, 0),
          deletions: files.reduce((sum, file) => sum + file.deletions, 0),
          truncated: result.truncated,
        });
      },
      // A failed ask is not "no repository": keep the row so the dialog stays reachable.
      () => {
        if (request === latest.current) setStat({ kind: "failed" });
      },
    );
  }, [remote, conversationId, busy, connected]);
  useEffect(() => setStat({ kind: "loading" }), [conversationId]);
  return stat;
}

const count = (value: number): string => value.toLocaleString("en-US");

function Section({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-0.5 border-b border-border px-3 py-2.5 last:border-b-0">
      {title === undefined ? null : <h2 className="pb-1 text-xs font-medium text-muted">{title}</h2>}
      {children}
    </section>
  );
}

/** One line: icon, text that truncates, optional trailing content. A button when it leads somewhere. */
function Row({
  icon,
  children,
  end,
  title,
  onClick,
}: {
  icon: ReactNode;
  children: ReactNode;
  end?: ReactNode;
  title?: string;
  onClick?: () => void;
}) {
  const content = (
    <>
      <span aria-hidden="true" className="flex size-4 shrink-0 items-center justify-center text-muted">
        {icon}
      </span>
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
  const branch = view.checkout?.branch;
  const isChat = view.home?.kind === "chat";
  return (
    <Section title="Workspace">
      {cwd === undefined ? null : (
        <Row icon={<FolderClosed className="size-4" />} title={cwd}>
          {/* A path's tail says where it is: an rtl box clips from the left,
              and the LRM keeps the leading "/" from flipping to the end. */}
          <span className="block truncate text-left [direction:rtl]">{`\u200E${cwd}`}</span>
        </Row>
      )}
      {branch === undefined ? null : <Row icon={<GitBranch className="size-4" />}>{branch}</Row>}
      {isChat ? null : (
        <ChangesRow
          remote={remote}
          conversationId={conversation.conversation.id}
          busy={busy}
          connected={view.connection === "connected"}
          onOpen={onOpenChanges}
        />
      )}
    </Section>
  );
}

function ChangesRow({
  remote,
  conversationId,
  busy,
  connected,
  onOpen,
}: {
  remote: RemoteDurable;
  conversationId: ConversationId;
  busy: boolean;
  connected: boolean;
  onOpen: () => void;
}) {
  const stat = useChangeStat(remote, conversationId, busy, connected);
  if (stat.kind === "unavailable") return null;
  const end =
    stat.kind === "loading" ? (
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
  return (
    <Row icon={<FileDiff className="size-4" />} end={end} onClick={onOpen}>
      Changes
    </Row>
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
    <Section title="Subagents">
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
  return (
    <Section title="Sources">
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
        <Section key={doc.kind}>
          <DocumentView doc={doc} remote={remote} connected={view.connection === "connected"} />
        </Section>
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
      className={`absolute end-3 top-3 z-20 flex max-h-[calc(100%-1.5rem)] ${narrow ? "w-[min(20rem,calc(100%-1.5rem))]" : "w-[var(--pigui-overview-width)]"} flex-col overflow-y-auto rounded-xl border border-border bg-[var(--color-background-popover)] shadow-[var(--shadow-med)]`}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        onClose();
      }}
    >
      <WorkspaceSection view={view} remote={remote} conversation={conversation} busy={busy} onOpenChanges={onOpenChanges} />
      <SubagentsSection view={view} conversation={conversation} onOpenTasks={onOpenTasks} />
      <SourcesSection view={view} />
      <DocumentsSection view={view} remote={remote} />
    </aside>
  );
}
