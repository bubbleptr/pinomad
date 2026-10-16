// Maps the run half of deriveChat (CotView, already stripped of lifted
// subagent calls) onto the JSON shape RunPayload.swift decodes into
// AgentChatKit's AgentTrace. Sent whole on every update; Swift diffs.
//
// Step and call ids are positional on purpose: upstream ids churn when a
// live partial commits ("live-thinking-0" -> "<entry>-thinking-0"), and tool
// call ids repeat across rounds. A stable per-run index keeps SwiftUI's
// ForEach diffing (and any expansion keyed by call id) from remounting.
import type { ChatEntry, CotView } from "@pinomad/client/cot-view.ts";
import { toolDisplayName, type ToolItem } from "@pinomad/client/tool-item.ts";
import type { MessageImage } from "@pinomad/protocol/images.ts";

/** Same cap as the RN tool-output pane — the trace is a summary, not a log. */
const OUTPUT_LINE_CAP = 40;

type NativeCall = {
  id: string;
  name: string;
  state: "streamingInput" | "running" | "succeeded" | "failed";
  input?: string;
  output?: string;
  durationMs?: number;
  diffStat?: { additions: number; deletions: number };
  children?: NativeCall[];
};

type NativeStep =
  | { id: string; kind: "thinking"; text: string; live: boolean; durationMs?: number }
  | { id: string; kind: "interim"; text: string }
  | { id: string; kind: "tools"; calls: NativeCall[] };

type NativeTrace = {
  id: string;
  phase: CotView["phase"];
  outcome?: "failed" | "interrupted";
  startedAt?: number;
  endedAt?: number;
  steps: NativeStep[];
};

type NativeAnswer = { id: string; text: string; streaming: boolean };

/** Long outputs dominate the snapshot's size; the folded row never shows them anyway. */
const capLines = (text: string | undefined): string | undefined => {
  if (text === undefined) return undefined;
  const lines = text.split("\n");
  return lines.length <= OUTPUT_LINE_CAP ? text : `${lines.slice(0, OUTPUT_LINE_CAP).join("\n")}\n…`;
};

function callOf(tool: ToolItem, id: string): NativeCall {
  const state =
    tool.state === "input-streaming"
      ? "streamingInput"
      : tool.state === "input-available"
        ? "running"
        : tool.state === "output-error"
          ? "failed"
          : "succeeded";
  return {
    id,
    name: toolDisplayName(tool.toolName) ?? "tool",
    state,
    ...(tool.argsText === undefined ? {} : { input: tool.argsText }),
    ...(tool.output === undefined ? {} : { output: capLines(tool.output) }),
    ...(tool.durationMs === undefined ? {} : { durationMs: tool.durationMs }),
    ...(tool.diffStat === undefined ? {} : { diffStat: tool.diffStat }),
    ...(tool.children === undefined || tool.children.length === 0
      ? {}
      : { children: tool.children.map((child, index) => callOf(child, `${id}.${index}`)) }),
  };
}

export function tracePayloadOf(entry: Extract<ChatEntry, { kind: "run" }>, view: CotView): NativeTrace {
  const steps: NativeStep[] = view.steps.map((step, index) => {
    const id = `step-${index}`;
    if (step.kind === "thinking") {
      return {
        id,
        kind: "thinking",
        text: step.text,
        live: step.live,
        ...(step.durationMs === undefined ? {} : { durationMs: step.durationMs }),
      };
    }
    if (step.kind === "interim") {
      return { id, kind: "interim", text: step.text };
    }
    return {
      id,
      kind: "tools",
      calls: step.tools.map((tool, callIndex) => callOf(tool, `${id}.${callIndex}`)),
    };
  });
  return {
    id: entry.id,
    phase: view.phase,
    ...(entry.failure !== undefined
      ? { outcome: "failed" as const }
      : entry.interrupted
        ? { outcome: "interrupted" as const }
        : {}),
    ...(view.anchorMs === undefined ? {} : { startedAt: view.anchorMs }),
    ...(view.anchorMs === undefined || view.elapsedMs === undefined
      ? {}
      : { endedAt: view.anchorMs + view.elapsedMs }),
    steps,
  };
}

export function answerPayloadOf(entry: Extract<ChatEntry, { kind: "run" }>): NativeAnswer | undefined {
  const answer = entry.cot.answer;
  if (answer === undefined) return undefined;
  return { id: entry.id, text: answer.text, streaming: answer.streaming };
}

/** Image-bearing tool output has no AgentChatKit channel; the caller renders
 *  these as RN thumbnails between the trace and the answer. */
export function runImagesOf(view: CotView): MessageImage[] {
  const images: MessageImage[] = [];
  const collect = (tool: ToolItem): void => {
    if (tool.images !== undefined) images.push(...(tool.images as readonly MessageImage[]));
    tool.children?.forEach(collect);
  };
  for (const step of view.steps) {
    if (step.kind === "tools") step.tools.forEach(collect);
  }
  return images;
}
