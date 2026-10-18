// Comparison vectors for the Rust `pinomad-core` derivations (ADR-0024 §6):
// the TypeScript reference computes each case once, the results are committed
// to `test/fixtures/rust-vectors/`, and the Rust suite replays them
// byte-for-byte. A vitest checks they are fresh — regenerate with
// PINOMAD_UPDATE_VECTORS=1. Inputs and outputs are written as wire text
// (JSON.stringify) exactly as the host delivers them.
import { applyImmutable } from "@earendil-works/chord/delta";
import type { ConversationView } from "@earendil-works/pi-durable";
import { MAX_IMAGES_PER_MESSAGE, imageProblem } from "@pinomad/protocol/images.ts";
import { checkoutOf, findConversation, homeOf, organize } from "@pinomad/protocol/organization.ts";
import { classify } from "@pinomad/protocol/presentation.ts";
import { isBusy } from "@pinomad/protocol/transcript.ts";
import { toolTarget } from "@pinomad/protocol/tool-target.ts";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveChat, retryOf, splitSubagentCalls } from "../src/cot-view.ts";
import { agentOf, queueItems, statusText, taskRows, usageRows } from "../src/chat.ts";
import { displayName, familyStatus, familyUpdatedAt, forksAt, relativeTime, rootOf, taskGroupsOf, threadsOf } from "../src/family.ts";
import { folderCrumbs, parentFolder } from "../src/folder-path.ts";
import {
  clampLevel,
  filterModels,
  modelLabel,
  reconcileDraftPick,
  sameModel,
  summaryOf,
  thinkingLevelLabels,
} from "../src/model.ts";
import { parsePatch } from "../src/patch.ts";
import { classifyProviderFailure } from "../src/provider-failure.ts";
import { pendingQuestions, questionAnswers } from "../src/questions.ts";
import { hostLabels, parseStoredHost, type StoredHost } from "../src/stored-host.ts";
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
import { IMAGE_CASES } from "../../protocol/test/images-cases.ts";
import { DERIVE_CHAT_CASES, RETRY_CASES, SPLIT_CASES } from "./cot-view-cases.ts";
import { AGENT_CASES, IS_BUSY_CASES, QUEUE_CASES, STATUS_CASES, TASK_GRAPH_CASES, USAGE_CASES } from "./chat-cases.ts";
import {
  CHECKOUT_OF_CASES,
  DISPLAY_NAME_CASES,
  FIND_CONVERSATION_CASES,
  FORKS_AT_CASES,
  HOME_OF_CASES,
  NODE_QUERIES,
  ORGANIZE_CASES,
  RELATIVE_TIME_CASES,
  ROOT_OF_CASES,
  familyByName,
} from "./family-cases.ts";
import { CLAMP_CASES, FILTER_CASES, MODEL_LABEL_CASES, RECONCILE_CASES, SAME_MODEL_CASES } from "./models-cases.ts";
import {
  ANSWER_CASES,
  CRUMB_CASES,
  FAILURE_CASES,
  HOST_CASES,
  HOST_LABEL_CASES,
  PENDING_QUESTION_CASES,
  PARENT_FOLDER_CASES,
} from "./misc-cases.ts";
import { PATCH_CASES } from "./patch-cases.ts";
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

// ─── Organization + family ───────────────────────────────────────────────────

const organizeInput = (index: unknown, summaries: unknown) => ({
  index: wire(index),
  summaries: wire(summaries),
});

/** A family input resolves to a node inside its organized tree. */
const nodeOf = (family: string, id: number) => {
  const input = familyByName(family);
  return findConversation(organize(input.index as never, input.summaries as never[]), id as never);
};

function organizeVector(): VectorFile {
  return write("organize", {
    organize: ORGANIZE_CASES.map((c) => ({
      name: c.name,
      ...organizeInput(c.index, c.summaries),
      expect: expect(wire(organize(c.index as never, c.summaries as never[]))),
    })),
    homeOf: HOME_OF_CASES.map((c) => ({
      name: c.name,
      ...organizeInput(c.index, c.summaries),
      id: c.id,
      expect: expect(wire(homeOf(c.index as never, c.summaries as never[], c.id as never) ?? null)),
    })),
    checkoutOf: CHECKOUT_OF_CASES.map((c) => ({
      name: c.name,
      ...organizeInput(c.index, c.summaries),
      id: c.id,
      expect: expect(wire(checkoutOf(c.index as never, c.summaries as never[], c.id as never) ?? null)),
    })),
    findConversation: FIND_CONVERSATION_CASES.map((c) => ({
      name: c.name,
      ...organizeInput(familyByName(c.family).index, familyByName(c.family).summaries),
      id: c.id,
      expect: expect(wire(nodeOf(c.family, c.id) ?? null)),
    })),
  });
}

function familyVector(): VectorFile {
  const nodeCases = (fn: (node: NonNullable<ReturnType<typeof nodeOf>>) => unknown) =>
    NODE_QUERIES.map((q) => ({
      name: q.name,
      ...organizeInput(familyByName(q.family).index, familyByName(q.family).summaries),
      id: q.id,
      expect: expect(wire(fn(nodeOf(q.family, q.id)!) ?? null)),
    }));
  return write("family", {
    familyStatus: nodeCases((node) => familyStatus(node) ?? null),
    familyUpdatedAt: nodeCases((node) => familyUpdatedAt(node) ?? null),
    threadsOf: nodeCases((node) => threadsOf(node)),
    taskGroupsOf: nodeCases((node) => taskGroupsOf(node)),
    displayName: DISPLAY_NAME_CASES.map((c) => ({
      name: c.name,
      summary: wire(c.summary ?? null),
      expect: expect(wire(displayName(c.summary as never))),
    })),
    relativeTime: RELATIVE_TIME_CASES.map((c) => ({
      name: c.name,
      at: c.at,
      now: c.now,
      expect: wire(relativeTime(c.at, c.now)),
    })),
    rootOf: ROOT_OF_CASES.map((c) => ({
      name: c.name,
      ...organizeInput(familyByName(c.family).index, familyByName(c.family).summaries),
      id: c.id,
      expect: expect(wire(rootOf(organize(familyByName(c.family).index as never, familyByName(c.family).summaries as never[]), c.id as never) ?? null)),
    })),
    forksAt: FORKS_AT_CASES.map((c) => ({
      name: c.name,
      ...organizeInput(familyByName(c.family).index, familyByName(c.family).summaries),
      conversationId: c.conversationId,
      entryId: c.entryId,
      expect: expect(
        wire(
          forksAt(
            organize(familyByName(c.family).index as never, familyByName(c.family).summaries as never[]),
            c.conversationId as never,
            c.entryId,
          ),
        ),
      ),
    })),
  });
}

// ─── Models ──────────────────────────────────────────────────────────────────

function modelsVector(): VectorFile {
  return write("models", {
    thinkingLevelLabels: wire(thinkingLevelLabels),
    sameModel: SAME_MODEL_CASES.map((c) => ({
      name: c.name,
      a: wire(c.a ?? null),
      b: wire(c.b ?? null),
      expect: wire(sameModel(c.a as never, c.b as never)),
    })),
    clampLevel: CLAMP_CASES.map((c) => ({
      name: c.name,
      levels: wire(c.levels),
      want: c.want,
      expect: expect(wire(clampLevel([...c.levels] as never[], c.want as never))),
    })),
    summaryOf: [
      { name: "hit", models: MODEL_LABEL_CASES[0]!.models, ref: { provider: "openai", modelId: "gpt-b" } },
      { name: "miss", models: MODEL_LABEL_CASES[0]!.models, ref: { provider: "gone", modelId: "claude-z" } },
      { name: "absent", models: MODEL_LABEL_CASES[0]!.models, ref: undefined },
    ].map((c) => ({
      name: c.name,
      models: wire(c.models),
      ref: wire(c.ref ?? null),
      expect: expect(wire(summaryOf(c.models as never, c.ref as never) ?? null)),
    })),
    modelLabel: MODEL_LABEL_CASES.map((c) => ({
      name: c.name,
      models: wire(c.models),
      selected: wire(c.selected),
      expect: expect(wire(modelLabel(c.models as never, c.selected as never))),
    })),
    filterModels: FILTER_CASES.map((c) => ({
      name: c.name,
      models: wire(c.models),
      query: c.query,
      expect: expect(wire(filterModels(c.models as never, c.query))),
    })),
    reconcileDraftPick: RECONCILE_CASES.map((c) => ({
      name: c.name,
      models: wire(c.models),
      defaults: wire(c.defaults),
      remembered: wire(c.remembered),
      expect: expect(wire(reconcileDraftPick(c.models as never, c.defaults as never, c.remembered as never))),
    })),
  });
}

// ─── Small standalone derivations ────────────────────────────────────────────

/** Image data longer than a few hundred units compresses to a repeat marker
    so the 5 MB boundary cases don't commit a 7 MB fixture. */
const compactImages = (images: readonly { data: string; mimeType: string }[]) =>
  images.map((image) =>
    image.data.length > 256
      ? {
          data: {
            $repeat: image.data.slice(0, 1),
            count: image.data.length - (image.data.endsWith("==") ? 2 : image.data.endsWith("=") ? 1 : 0),
            tail: image.data.endsWith("==") ? "==" : image.data.endsWith("=") ? "=" : "",
          },
          mimeType: image.mimeType,
        }
      : image,
  );

function miscVector(): VectorFile {
  return write("misc", {
    pendingQuestions: PENDING_QUESTION_CASES.map((c) => ({
      name: c.name,
      docs: wire(c.docs),
      expect: expect(wire(pendingQuestions(c.docs as never))),
    })),
    questionAnswers: ANSWER_CASES.map((c) => ({
      name: c.name,
      questionCount: c.questionCount,
      selections: wire(c.selections),
      others: wire(c.others),
      expect: expect(wire(questionAnswers(c.questionCount, [...c.selections], [...c.others]))),
    })),
    folderCrumbs: CRUMB_CASES.map((c) => ({
      name: c.name,
      path: c.path,
      home: c.home,
      expect: expect(wire(folderCrumbs(c.path, c.home))),
    })),
    parentFolder: PARENT_FOLDER_CASES.map((c) => ({
      name: c.name,
      path: c.path,
      expect: expect(wire(parentFolder(c.path) ?? null)),
    })),
    parseStoredHost: HOST_CASES.map((c) => ({
      name: c.name,
      value: wire(c.value === undefined ? null : c.value),
      expect: expect(wire(parseStoredHost(c.value) ?? null)),
    })),
    hostLabels: HOST_LABEL_CASES.map((c) => ({
      name: c.name,
      hosts: wire(c.hosts),
      expect: expect(wire(Object.fromEntries(hostLabels(c.hosts)))),
    })),
    classifyProviderFailure: FAILURE_CASES.map((c) => ({
      name: c.name,
      error: wire(c.error === undefined ? null : c.error),
      expect: wire(classifyProviderFailure(c.error)),
    })),
    imageProblem: IMAGE_CASES.map((c) => ({
      name: c.name,
      images: wire(compactImages(c.images)),
      expect: expect(wire(imageProblem([...c.images]) ?? null)),
    })),
    maxImagesPerMessage: wire(MAX_IMAGES_PER_MESSAGE),
  });
}

function patchVector(): VectorFile {
  return write("patch", {
    parsePatch: PATCH_CASES.map((c) => ({
      name: c.name,
      patch: c.patch,
      expect: expect(wire(parsePatch(c.patch))),
    })),
  });
}

export function buildVectors(): VectorFile[] {
  return [chatVector(), chatMetaVector(), toolsVector(), organizeVector(), familyVector(), modelsVector(), miscVector(), patchVector()];
}
