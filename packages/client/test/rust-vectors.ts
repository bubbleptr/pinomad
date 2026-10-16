// Comparison vectors for the Rust `pinomad-core` derivations (ADR-0024 §6):
// the TypeScript reference computes each case once, the results are committed
// to `test/fixtures/rust-vectors/`, and the Rust suite replays them
// byte-for-byte. A vitest checks they are fresh — regenerate with
// PINOMAD_UPDATE_VECTORS=1. Inputs and outputs are written as wire text
// (JSON.stringify) exactly as the host delivers them.
import { applyImmutable } from "@earendil-works/chord/delta";
import type { ConversationView } from "@earendil-works/pi-durable";
import { classify } from "@pinomad/protocol/presentation.ts";
import { isBusy } from "@pinomad/protocol/transcript.ts";
import { toolTarget } from "@pinomad/protocol/tool-target.ts";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveChat, retryOf, splitSubagentCalls } from "../src/cot-view.ts";
import { agentOf, queueItems, statusText, taskRows, usageRows } from "../src/chat.ts";
import { toolDiffStatFromResult } from "../src/tool-diff-stat.ts";
import {
  formatToolDuration,
  normalizeToolName,
  toolDisplayName,
  toolKindFromName,
  toolKindFromTools,
  toolTargetFromArgs,
  type ToolItem,
} from "../src/tool-item.ts";
import { DERIVE_CHAT_CASES, RETRY_CASES, SPLIT_CASES } from "./cot-view-cases.ts";
import { AGENT_CASES, IS_BUSY_CASES, QUEUE_CASES, STATUS_CASES, TASK_GRAPH_CASES, USAGE_CASES } from "./chat-cases.ts";
import {
  CLASSIFY_CASES,
  DIFF_STAT_CASES,
  TOOL_DISPLAY_NAME_CASES,
  TOOL_DURATION_CASES,
  TOOL_KIND_SETS,
  TOOL_NAME_CASES,
  TOOL_TARGET_ARGS_CASES,
  TOOL_TARGET_CASES,
} from "./tools-cases.ts";

export interface VectorFile {
  readonly name: string;
  readonly text: string;
}

const write = (name: string, data: unknown): VectorFile => ({
  name,
  text: `${JSON.stringify(data, null, 2)}\n`,
});

/** `JSON.stringify` of a value — what the vectors compare byte-for-byte. */
const wire = (value: unknown): string => JSON.stringify(value);

// The Rust side renders lone surrogates as U+FFFD at the UI boundary (the
// u16str lossy rule), so the committed expected text substitutes them rather
// than requiring the Rust side to emit surrogates it never produces. Only a
// real \uXXXX escape is rewritten — an even run of preceding backslashes
// means the `u` is literal text.
const expect = (wireText: string): string => {
  let out = "";
  let i = 0;
  while (i < wireText.length) {
    if (wireText[i] !== "\\") {
      out += wireText[i];
      i += 1;
      continue;
    }
    let run = 0;
    while (wireText[i + run] === "\\") run += 1;
    const hex = run % 2 === 1 && wireText[i + run] === "u" ? wireText.slice(i + run + 1, i + run + 5) : "";
    const code = /^[0-9a-fA-F]{4}$/.test(hex) ? parseInt(hex, 16) : 0;
    if (code >= 0xd800 && code <= 0xdfff) {
      out += "\\".repeat(run - 1) + "\uFFFD";
      i += run + 5;
    } else {
      out += "\\".repeat(run);
      i += run;
    }
  }
  return out;
};

/** The `conversation:4` stream from the recorded host session, after its ops. */
function recordedConversation(): { view: ConversationView; presentations: Record<string, string>; busy: boolean } {
  const path = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "protocol", "test", "fixtures", "host-frames.json");
  const frames = JSON.parse(readFileSync(path, "utf8")) as { stream?: string; value?: unknown; ops?: unknown[] }[];
  const conversation = frames.filter((frame) => frame.stream === "conversation:4");
  let view = conversation.find((frame) => frame.value !== undefined)!.value as ConversationView;
  for (const frame of conversation.filter((frame) => frame.ops !== undefined)) {
    view = applyImmutable(view, frame.ops as never) as ConversationView;
  }
  const hello = frames.find((frame) => (frame as { type?: string }).type === "hello") as { toolPresentations: Record<string, string> };
  return { view, presentations: hello.toolPresentations, busy: isBusy(view) };
}

function chatVector(): VectorFile {
  const recorded = recordedConversation();
  const cases = [
    ...DERIVE_CHAT_CASES,
    { name: "recorded", view: recorded.view, busy: recorded.busy, presentations: recorded.presentations },
  ];
  return write("chat", {
    deriveChat: cases.map((c) => ({
      name: c.name,
      view: wire(c.view),
      busy: c.busy,
      presentations: wire(c.presentations ?? {}),
      expect: expect(wire(deriveChat(c.view, (c.presentations ?? {}) as never, c.busy))),
    })),
    retryOf: RETRY_CASES.map((c) => ({
      name: c.name,
      view: wire(c.view),
      busy: c.busy,
      presentations: wire(c.presentations ?? {}),
      expect: expect(wire(retryOf(deriveChat(c.view, (c.presentations ?? {}) as never, c.busy)) ?? null)),
    })),
    splitSubagentCalls: SPLIT_CASES.map((c) => ({
      name: c.name,
      cot: expect(wire(c.cot)),
      expect: expect(wire(splitSubagentCalls(c.cot))),
    })),
  });
}

function chatMetaVector(): VectorFile {
  return write("chat-meta", {
    agentOf: AGENT_CASES.map((c) => ({ name: c.name, view: wire(c.input), expect: expect(wire(agentOf(c.input))) })),
    statusText: STATUS_CASES.map((c) => ({ name: c.name, view: wire(c.input), expect: expect(wire(statusText(c.input))) })),
    queueItems: QUEUE_CASES.map((c) => ({ name: c.name, view: wire(c.input), expect: expect(wire(queueItems(c.input))) })),
    usageRows: USAGE_CASES.map((c) => ({ name: c.name, view: wire(c.input), expect: expect(wire(usageRows(c.input))) })),
    taskRows: TASK_GRAPH_CASES.map((c) => ({ name: c.name, graph: wire(c.input), expect: expect(wire(taskRows(c.input))) })),
    isBusy: IS_BUSY_CASES.map((c) => ({ name: c.name, view: wire(c.input), expect: expect(wire(isBusy(c.input))) })),
  });
}

function toolsVector(): VectorFile {
  return write("tools", {
    classify: CLASSIFY_CASES.map((c) => ({
      name: c.name,
      presentation: c.presentation === undefined ? null : wire(c.presentation),
      value: wire(c.value),
      expect: expect(wire(classify(c.presentation as never, c.value))),
    })),
    toolTarget: TOOL_TARGET_CASES.map((c) => ({
      name: c.name,
      args: wire(c.input),
      expect: expect(wire(toolTarget(c.input) ?? null)),
    })),
    toolTargetFromArgs: TOOL_TARGET_ARGS_CASES.map((c) => ({
      name: c.name,
      argsText: c.input === undefined ? null : wire(c.input),
      expect: expect(wire(toolTargetFromArgs(c.input) ?? null)),
    })),
    toolDisplayName: TOOL_DISPLAY_NAME_CASES.map((c) => ({
      name: c.name,
      tool: c.input === undefined ? null : wire(c.input),
      expect: expect(wire(toolDisplayName(c.input) ?? null)),
    })),
    formatToolDuration: TOOL_DURATION_CASES.map((c) => ({
      name: c.name,
      durationMs: c.input === undefined ? null : wire(c.input),
      expect: expect(wire(formatToolDuration(c.input) ?? null)),
    })),
    toolKindFromName: TOOL_NAME_CASES.map((c) => ({
      name: c.name,
      tool: c.input === undefined ? null : wire(c.input),
      normalized: expect(wire(normalizeToolName(c.input))),
      expect: expect(wire(toolKindFromName(c.input))),
    })),
    toolKindFromTools: TOOL_KIND_SETS.map((c) => {
      const tools: ToolItem[] = c.input.map((name) => ({
        state: "output-available",
        ...(name === undefined ? {} : { toolName: name }),
      }));
      return { name: c.name, tools: wire(tools), expect: expect(wire(toolKindFromTools(tools))) };
    }),
    toolDiffStatFromResult: DIFF_STAT_CASES.map((c) => ({
      name: c.name,
      result: wire(c.input),
      expect: expect(wire(toolDiffStatFromResult(c.input) ?? null)),
    })),
  });
}

export function buildVectors(): VectorFile[] {
  return [chatVector(), chatMetaVector(), toolsVector()];
}
