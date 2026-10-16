// Maps the run half of deriveChat (CotView, already stripped of lifted
// subagent calls) onto the JSON shape RunPayload.swift decodes into
// AgentChatKit's AgentTrace. Sent whole on every update; Swift diffs.
import type { ChatEntry, CotView } from "@pinomad/client/cot-view.ts";
import { toolDisplayName, type ToolItem } from "@pinomad/client/tool-item.ts";

type NativeCall = {
  id: string;
  name: string;
  state: "streamingInput" | "running" | "succeeded" | "failed";
  input?: string;
  output?: string;
  durationMs?: number;
  children?: NativeCall[];
};

type NativeStep =
  | { id: string; kind: "thinking"; text: string; live: boolean }
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

function callOf(tool: ToolItem, fallbackId: string): NativeCall {
  const state =
    tool.state === "input-streaming"
      ? "streamingInput"
      : tool.state === "input-available"
        ? "running"
        : tool.state === "output-error"
          ? "failed"
          : "succeeded";
  return {
    id: tool.toolCallId ?? fallbackId,
    name: toolDisplayName(tool.toolName) ?? "tool",
    state,
    ...(tool.argsText === undefined ? {} : { input: tool.argsText }),
    ...(tool.output === undefined ? {} : { output: tool.output }),
    ...(tool.durationMs === undefined ? {} : { durationMs: tool.durationMs }),
    ...(tool.children === undefined || tool.children.length === 0
      ? {}
      : { children: tool.children.map((child, index) => callOf(child, `${fallbackId}-${index}`)) }),
  };
}

export function tracePayloadOf(entry: Extract<ChatEntry, { kind: "run" }>, view: CotView): NativeTrace {
  const steps: NativeStep[] = view.steps.map((step) => {
    if (step.kind === "thinking") {
      return { id: step.id, kind: "thinking", text: step.text, live: step.live };
    }
    if (step.kind === "interim") {
      return { id: step.id, kind: "interim", text: step.text };
    }
    return {
      id: step.id,
      kind: "tools",
      calls: step.tools.map((tool, index) => callOf(tool, `${step.id}-${index}`)),
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
