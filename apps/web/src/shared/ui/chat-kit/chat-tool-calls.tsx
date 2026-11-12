// Copyright (c) Meta Platforms, Inc. and affiliates.
// Ported from @astryxdesign/core 0.3.0 src/Chat/ChatToolCalls.tsx (MIT).
// chat.css reaches into this DOM (`[role="button"] > span:first-child` is the
// status icon), so the element order is kept as Astryx renders it.

import { useState, useCallback, useId, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { cn } from "cn";
import { ChatBadge } from "./chat-badge";
import { ChatKitIcon, type ChatKitIconName } from "./chat-kit-icons";
import { ChatSpinner } from "./chat-spinner";
import { themeProps, type BaseProps } from "./theme-props";

// =============================================================================
// Types
// =============================================================================

export type ChatToolCallStatus = "pending" | "running" | "complete" | "error";

export interface ChatToolCallItem {
  /** Tool/function name. */
  name: string;
  /** Current execution status. @default 'complete' */
  status?: ChatToolCallStatus;
  /** The target of the action (e.g. "Button.tsx", "yarn test", "CSS anchor positioning"). */
  target?: string;
  /** Duration string (e.g. "1.2s", "340ms"). Shown when complete. */
  duration?: string;
  /** Sandbox/node name (e.g. "navi", "xds"). Shown as a pill badge. */
  node?: string;
  /** Lines/characters added. Rendered in green (e.g. "+12"). */
  additions?: number;
  /** Lines/characters removed. Rendered in red (e.g. "-3"). */
  deletions?: number;
  /** Additional info rendered after the label. Free-form ReactNode. */
  stats?: ReactNode;
  /**
   * Error message when status is 'error'. Rendered as visually hidden text in
   * the row (so screen readers and keyboard users perceive it) and echoed in a
   * hover tooltip on the status icon.
   */
  errorMessage?: string;
  /** Unique key for React list rendering. Derived from stable metadata if omitted. */
  key?: string;
  /** Arbitrary data passed through to renderDetail. Store tool args, result, etc. */
  data?: unknown;
  /** Inline detail content shown when the row is expanded (e.g. code diff, command output). */
  resultDetail?: ReactNode;
}

export interface ChatToolCallsProps extends BaseProps<HTMLDivElement> {
  ref?: Ref<HTMLDivElement>;
  /** Array of tool call data. */
  calls: ChatToolCallItem[];
  /** Custom summary label for groups. Auto-generated from count if omitted. */
  label?: string;
  /** Whether the group is expanded. Uncontrolled by default. */
  isExpanded?: boolean;
  /** Default expanded state. @default false */
  defaultIsExpanded?: boolean;
  /** Callback when expanded state changes. */
  onExpandedChange?: (isExpanded: boolean) => void;
}

// =============================================================================
// Styles
// =============================================================================

const supporting = "text-[length:var(--font-size-sm)] leading-[1.6667]";
const chevronTransition =
  "transition-[transform] duration-[var(--duration-fast)] ease-[var(--ease-standard)] motion-reduce:transition-none";

const styles = {
  root: "mt-2 flex flex-col",
  groupIcon: "inline-flex size-4 shrink-0 items-center justify-center text-[var(--muted-foreground)]",
  groupLabel: cn(supporting, "font-sans font-medium text-[var(--muted-foreground)]"),
  chevron: cn("inline-flex size-3.5 shrink-0 items-center justify-center text-[var(--disabled-foreground)]", chevronTransition),
  chevronExpanded: "[transform:rotate(180deg)]",
  groupContent:
    "grid grid-rows-[0fr] transition-[grid-template-rows] duration-300 ease-[var(--ease-standard)] motion-reduce:transition-none",
  groupContentExpanded: "grid-rows-[1fr]",
  groupContentInner: "min-h-0 overflow-hidden",
  list: "-mx-1 flex flex-col px-1",
  callRow: "flex min-h-6 items-center gap-1.5 py-0.5",
  callRowClickable: "-mx-1 cursor-pointer rounded-[var(--radius-element)] px-1 hover:bg-[var(--surface-hover)]",
  callRowToggle: "cursor-pointer",
  statusIcon: "relative inline-flex size-4 shrink-0 items-center justify-center rounded-[var(--radius-full)]",
  statusIconCircle: "absolute inset-0 rounded-[inherit] bg-current opacity-15",
  statusIconInner: "relative inline-flex",
  callName: cn(
    supporting,
    "min-w-[4ch] shrink truncate font-mono font-medium text-[var(--muted-foreground)]",
  ),
  callLabel: cn(supporting, "min-w-0 shrink-[10] truncate font-sans text-[var(--disabled-foreground)]"),
  callDuration: cn(supporting, "shrink-0 font-sans whitespace-nowrap text-[var(--disabled-foreground)]"),
  stats: cn(supporting, "flex shrink-0 items-center gap-1 font-sans text-[var(--disabled-foreground)]"),
  statsAdditions: "text-[var(--success)]",
  statsDeletions: "text-[var(--destructive-strong)]",
  callDetailChevron: cn(
    "ms-auto inline-flex size-3.5 shrink-0 items-center justify-center text-[var(--disabled-foreground)]",
    chevronTransition,
  ),
  callDetailContent: "ps-[calc(16px_+_var(--spacing-1-5))] pb-2",
  callCount: cn(supporting, "inline-flex shrink-0 items-center gap-0.5 font-sans text-[var(--disabled-foreground)]"),
};

// =============================================================================
// Status Icons
// =============================================================================

const STATUS_ICON_NAMES: Record<ChatToolCallStatus, ChatKitIconName | null> = {
  pending: "clock",
  running: null,
  complete: "check",
  error: "close",
};

const STATUS_STYLES: Record<ChatToolCallStatus, string> = {
  pending: "text-[var(--disabled-foreground)]",
  running: "text-[var(--primary)]",
  complete: "text-[var(--success)]",
  error: "text-[var(--destructive-strong)]",
};

function getToolCallKey(call: ChatToolCallItem): string {
  if (call.key != null) {
    return `id:${call.key}`;
  }
  return `fallback:${[
    call.name,
    call.status ?? "complete",
    call.target ?? "",
    call.node ?? "",
    call.duration ?? "",
    call.additions?.toString() ?? "",
    call.deletions?.toString() ?? "",
    call.errorMessage ?? "",
  ].join("\u001F")}`;
}

function StatusGlyph({ status }: { status: ChatToolCallStatus }) {
  return status === "running" || status === "pending" ? (
    <ChatSpinner size="sm" shade="subtle" />
  ) : (
    <>
      <span className={styles.statusIconCircle} />
      <span className={styles.statusIconInner}>
        <ChatKitIcon name={STATUS_ICON_NAMES[status] ?? "check"} size="xsm" />
      </span>
    </>
  );
}

// =============================================================================
// Internal: single call row
// =============================================================================

function CallRow({ call }: { call: ChatToolCallItem }) {
  const status = call.status ?? "complete";
  const hasDetail = call.resultDetail != null;
  const [isDetailOpen, setIsDetailOpen] = useState(false);
  const detailId = useId();

  const toggleDetail = hasDetail ? () => setIsDetailOpen((prev) => !prev) : undefined;

  const row = (
    <div
      role={hasDetail ? "button" : undefined}
      tabIndex={hasDetail ? 0 : undefined}
      aria-expanded={hasDetail ? isDetailOpen : undefined}
      aria-controls={hasDetail && isDetailOpen ? detailId : undefined}
      onClick={toggleDetail}
      onKeyDown={
        hasDetail
          ? (e: KeyboardEvent) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                toggleDetail?.();
              }
            }
          : undefined
      }
      className={cn(styles.callRow, hasDetail && styles.callRowClickable)}
    >
      <span
        title={status === "error" ? call.errorMessage : undefined}
        className={cn(styles.statusIcon, STATUS_STYLES[status])}
      >
        <StatusGlyph status={status} />
        {status === "error" && call.errorMessage != null && (
          // The title attribute above is hover-only; expose the error detail
          // as real text so it reaches screen readers, keyboard, and touch
          // users, and joins the accessible name of expandable rows.
          <span className="pointer-events-none absolute start-0 top-0 -m-px size-px overflow-hidden border-none p-0 whitespace-nowrap select-none [clip:rect(0,0,0,0)]">{`Error: ${call.errorMessage ?? ""}`}</span>
        )}
      </span>
      <span className={styles.callName}>{call.name}</span>
      {call.node != null && <ChatBadge label={call.node} variant="neutral" className="shrink-0" />}
      {call.target != null && <span className={styles.callLabel}>{call.target}</span>}
      {(call.additions != null || call.deletions != null || call.stats != null) && (
        <span className={styles.stats}>
          {call.additions != null && <span className={styles.statsAdditions}>+{call.additions}</span>}
          {call.deletions != null && <span className={styles.statsDeletions}>-{call.deletions}</span>}
          {call.stats}
        </span>
      )}
      {call.duration != null && status === "complete" && <span className={styles.callDuration}>{call.duration}</span>}
      {hasDetail && (
        <span className={cn(styles.callDetailChevron, isDetailOpen && styles.chevronExpanded)}>
          <ChatKitIcon name="chevronDown" size="xsm" />
        </span>
      )}
    </div>
  );

  if (!hasDetail) {
    return row;
  }

  return (
    <div>
      {row}
      {isDetailOpen && (
        <div id={detailId} className={styles.callDetailContent}>
          {call.resultDetail}
        </div>
      )}
    </div>
  );
}

// =============================================================================
// Component
// =============================================================================

export function ChatToolCalls(props: ChatToolCallsProps) {
  const {
    calls,
    label: _customLabel,
    isExpanded: controlledExpanded,
    defaultIsExpanded,
    onExpandedChange,
    className,
    style,
    ref,
    ...rest
  } = props;

  const autoDefault = defaultIsExpanded ?? false;
  const [internalExpanded, setInternalExpanded] = useState(autoDefault);
  const contentId = useId();
  const isControlled = controlledExpanded !== undefined;
  const isExpanded = isControlled ? controlledExpanded : internalExpanded;

  const toggle = useCallback(() => {
    const next = !isExpanded;
    if (!isControlled) {
      setInternalExpanded(next);
    }
    onExpandedChange?.(next);
  }, [isExpanded, isControlled, onExpandedChange]);

  if (calls.length === 0) {
    return null;
  }

  const theme = themeProps("chat-tool-calls");
  const rootProps = {
    ref,
    ...theme,
    className: cn(theme.className, styles.root, className),
    style,
    ...rest,
  };

  // Single call: render inline, no group chrome
  if (calls.length === 1) {
    return (
      <div {...rootProps}>
        <CallRow call={calls[0]!} />
      </div>
    );
  }

  // Multiple calls: latest call at surface with chevron to expand all
  const latestCall = calls[calls.length - 1]!;
  const latestStatus = latestCall.status ?? "complete";

  return (
    <div {...rootProps}>
      {/* Header: collapsed shows latest call + count, expanded shows summary label */}
      <div
        role="button"
        tabIndex={0}
        aria-expanded={isExpanded}
        aria-controls={contentId}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggle();
          }
        }}
        className={cn(styles.callRow, styles.callRowToggle)}
      >
        {isExpanded ? (
          <>
            <span className={styles.groupIcon}>
              <ChatKitIcon name="wrench" size="sm" />
            </span>
            <span className={styles.groupLabel}>{`${calls.length} tool calls`}</span>
          </>
        ) : (
          <>
            <span className={cn(styles.statusIcon, STATUS_STYLES[latestStatus])}>
              <StatusGlyph status={latestStatus} />
            </span>
            <span className={styles.callName}>{latestCall.name}</span>
            {latestCall.target != null && <span className={styles.callLabel}>{latestCall.target}</span>}
          </>
        )}
        <span className={styles.callCount}>
          {!isExpanded && (
            <>
              <ChatKitIcon name="wrench" size="xsm" />
              {calls.length}
            </>
          )}
        </span>
        <span className={cn(styles.chevron, isExpanded && styles.chevronExpanded)}>
          <ChatKitIcon name="chevronDown" size="xsm" />
        </span>
      </div>

      {/* Expanded: all calls with full metadata */}
      <div id={contentId} className={cn(styles.groupContent, isExpanded && styles.groupContentExpanded)}>
        <div className={styles.groupContentInner}>
          <div className={styles.list}>
            {calls.map((call) => (
              <CallRow key={getToolCallKey(call)} call={call} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

ChatToolCalls.displayName = "ChatToolCalls";
