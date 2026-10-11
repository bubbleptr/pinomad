import {
  ChatToolCalls,
  type ChatToolCallItem,
  type ChatToolCallStatus,
} from "@astryxdesign/core";
import type { ComponentProps, ReactNode } from "react";
import {
  formatToolDuration,
  toolDisplayName,
  toolKindFromName,
  toolTargetFromArgs,
  type ToolItem,
  type ToolPartState,
} from "@pinomad/client/tool-item.ts";
import { ChatToolKindIcon } from "@/shared/ui/chat/chat-tool-kind";

/** A transcript tool item plus this client's React detail pane. */
export type ChatToolItem = Omit<ToolItem, "children"> & {
  children?: ChatToolItem[];
  // PiNomad: a ready-made detail pane (diff view, subagent card) replacing the
  // args and output panes; nested children still render.
  detail?: ReactNode;
};

const statusMap: Record<ToolPartState, ChatToolCallStatus> = {
  "input-streaming": "running",
  "input-available": "running",
  "output-available": "complete",
  "output-error": "error",
};

export function hasToolDetail(tool: ChatToolItem) {
  return (
    tool.argsText != null ||
    tool.output != null ||
    (tool.children?.length ?? 0) > 0 ||
    // PiNomad: a custom detail or result images also make the row expandable.
    tool.detail != null ||
    (tool.images?.length ?? 0) > 0
  );
}

/**
 * The args and output panes of one call. Rendered inside the Astryx row when
 * it expands, and directly by a single-call ChatToolStep, whose own row
 * already names the call — a second header there would only cost a click.
 * Nested Tool Executions sit between args and result, in the same per-call
 * row shape a multi-call ChatToolStep uses.
 */
export type ChatToolDetailProps = Omit<ComponentProps<"div">, "children"> & {
  tool: ChatToolItem;
};

export function ChatToolDetail({ tool, className, ...rest }: ChatToolDetailProps) {
  return (
    <div className={className} {...rest}>
      {/* PiNomad: a custom detail replaces the args and output panes; nested
          children still render below it. */}
      {tool.detail !== undefined && tool.detail !== null ? (
        tool.detail
      ) : (
        <>
          {tool.argsText != null ? (
            <pre className="chat-tool__section" data-slot="chat-tool-args">
              {tool.argsText}
            </pre>
          ) : null}
          {tool.output !== undefined ? (
            <pre className="chat-tool__section" data-slot="chat-tool-result">
              {tool.output}
            </pre>
          ) : null}
        </>
      )}
      {tool.children?.length ? (
        <ol className="chat-tool-step__list" data-slot="chat-tool-children">
          {tool.children.map((child, index) => (
            <li key={child.toolCallId ?? index} className="chat-tool-step__item">
              <ChatToolKindIcon kind={toolKindFromName(child.toolName)} />
              <ChatToolGroup tools={[child]} />
            </li>
          ))}
        </ol>
      ) : null}
      {/* PiNomad: result images follow the panes. */}
      {tool.images?.map((image, index) => (
        <img
          key={index}
          src={`data:${image.mimeType};base64,${image.data}`}
          alt=""
          style={{ maxWidth: "100%" }}
        />
      ))}
    </div>
  );
}

function toAstryxCall(tool: ChatToolItem, index: number): ChatToolCallItem {
  const resultDetail = hasToolDetail(tool) ? <ChatToolDetail tool={tool} /> : undefined;

  return {
    name: toolDisplayName(tool.toolName) ?? "tool",
    status: statusMap[tool.state],
    target: toolTargetFromArgs(tool.argsText),
    ...(tool.diffStat
      ? { additions: tool.diffStat.additions, deletions: tool.diffStat.deletions }
      : {}),
    duration: formatToolDuration(tool.durationMs),
    errorMessage: tool.state === "output-error" ? tool.output : undefined,
    key: tool.toolCallId ?? `tool-${index}`,
    resultDetail,
  };
}

/**
 * Adapter over Astryx ChatToolCalls. One call renders as an inline row;
 * several collapse into the "N tool calls" summary Astryx provides. The
 * wrapper div carries the data-slot contract page tests assert on.
 */
export type ChatToolGroupProps = Omit<ComponentProps<"div">, "children"> & {
  tools: ChatToolItem[];
};

export function ChatToolGroup({
  tools,
  className = "",
  ...rest
}: ChatToolGroupProps) {
  if (!tools.length) {
    return null;
  }

  return (
    <div
      className={`chat-tool ${className}`.trim()}
      data-slot="chat-tool-group"
      data-tool-count={tools.length}
      // Single-call groups keep the per-tool state contract on the wrapper.
      data-state={tools.length === 1 ? tools[0].state : undefined}
      {...rest}
    >
      <ChatToolCalls calls={tools.map(toAstryxCall)} />
    </div>
  );
}

/**
 * Single-call sugar over ChatToolGroup, keeping the original data-slot and
 * data-state contract (detail stays unmounted while collapsed — Astryx
 * native behavior).
 */
export type ChatToolProps = Omit<ComponentProps<"div">, keyof ChatToolItem | "children"> &
  ChatToolItem;

export function ChatTool({
  argsText,
  children,
  detail,
  diffStat,
  durationMs,
  images,
  output,
  state,
  toolCallId,
  toolName,
  className = "",
  ...rest
}: ChatToolProps) {
  return (
    <div
      className={`chat-tool ${className}`.trim()}
      data-slot="chat-tool"
      data-state={state}
      data-tool-call-id={toolCallId}
      {...rest}
    >
      <ChatToolCalls
        calls={[
          toAstryxCall(
            { argsText, children, detail, diffStat, durationMs, images, output, state, toolCallId, toolName },
            0,
          ),
        ]}
      />
    </div>
  );
}
