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
import {
  accountPairingFragment,
  createAccountClient,
  isSecureServerOrigin,
  matchAccountHosts,
  normalizeServerOrigin,
  probeAccounts,
  type AccountClient,
  type AccountFetch,
  type AccountFetchInit,
} from "../src/account.ts";
import { classify } from "@pinomad/protocol/presentation.ts";
import { isBusy } from "@pinomad/protocol/transcript.ts";
import { toolTarget } from "@pinomad/protocol/tool-target.ts";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveChat, retryOf, splitSubagentCalls } from "../src/cot-view.ts";
import { agentOf, queueItems, queuedInput, statusText, taskRows, usageRows } from "../src/chat.ts";
import { contextUsage } from "../src/context-usage.ts";
import { displayName, familyStatus, familyUpdatedAt, forksAt, relativeTime, rootOf, taskGroupsOf, threadsOf } from "../src/family.ts";
import { folderCrumbs, parentFolder } from "../src/folder-path.ts";
import {
  clampLevel,
  filterModels,
  modelLabel,
  reconcileDraftPick,
  resolveAgentDraft,
  sameModel,
  summaryOf,
  thinkingLevelLabels,
} from "../src/model.ts";
import { parsePatch } from "../src/patch.ts";
import { stripUserBlocks, type UserContent } from "../src/skill-blocks.ts";
import { skillMentionRanges } from "../src/skill-mentions.ts";
import { parseCommandInput } from "../src/command-input.ts";
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
import {
  MATCH_CASES,
  NORMALIZE_ORIGIN_CASES,
  OFFER_CASES,
  PROBE_CASES,
  PROBE_REQUEST_CASES,
  REQUEST_CASES,
  RESPONSE_CASES,
  SECURE_ORIGIN_CASES,
  type AccountOpDesc,
} from "./account-cases.ts";
import { DERIVE_CHAT_CASES, RETRY_CASES, SPLIT_CASES } from "./cot-view-cases.ts";
import {
  AGENT_CASES,
  IS_BUSY_CASES,
  QUEUED_INPUT_CASES,
  QUEUE_CASES,
  QUEUE_SUBMISSION_CASES,
  STATUS_CASES,
  TASK_GRAPH_CASES,
  USAGE_CASES,
} from "./chat-cases.ts";
import { CONTEXT_USAGE_CASES } from "./context-usage-cases.ts";
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
import {
  AGENT_DRAFT_CASES,
  CLAMP_CASES,
  FILTER_CASES,
  MODEL_LABEL_CASES,
  RECONCILE_CASES,
  SAME_MODEL_CASES,
} from "./models-cases.ts";
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
import { SKILL_BLOCK_CASES } from "./skill-blocks-cases.ts";
import { USER_BLOCK_CASES } from "./attachment-blocks-cases.ts";
import { SKILL_MENTION_CASES } from "./skill-mentions-cases.ts";
import { COMMAND_INPUT_CASES } from "./command-input-cases.ts";
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
    { name: "recorded", view: recorded.view, busy: recorded.busy, presentations: recorded.presentations, submissions: [], mergeQueued: false },
  ];
  return write("chat", {
    deriveChat: cases.map((c) => ({
      name: c.name,
      view: wire(c.view),
      busy: c.busy,
      presentations: wire(c.presentations ?? {}),
      submissions: wire(c.submissions ?? []),
      mergeQueued: c.mergeQueued ?? false,
      expect: expect(wire(deriveChat(c.view, (c.presentations ?? {}) as never, c.busy, c.submissions ?? [], {
        mergeQueuedSubmissions: c.mergeQueued ?? false,
      }))),
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
    queueSubmissions: QUEUE_SUBMISSION_CASES.map((c) => ({
      name: c.name,
      view: wire(c.input.view),
      submissions: wire(c.input.submissions),
      expect: expect(wire(queueItems(c.input.view, c.input.submissions))),
    })),
    queuedInput: QUEUED_INPUT_CASES.map((c) => ({
      name: c.name,
      view: wire(c.input.view),
      id: c.input.id,
      expect: expect(wire(queuedInput(c.input.view, c.input.id) ?? null)),
    })),
    usageRows: USAGE_CASES.map((c) => ({ name: c.name, view: wire(c.input), expect: expect(wire(usageRows(c.input))) })),
    taskRows: TASK_GRAPH_CASES.map((c) => ({ name: c.name, graph: wire(c.input), expect: expect(wire(taskRows(c.input))) })),
    isBusy: IS_BUSY_CASES.map((c) => ({ name: c.name, view: wire(c.input), expect: expect(wire(isBusy(c.input))) })),
    contextUsage: CONTEXT_USAGE_CASES.map((c) => ({
      name: c.name,
      view: wire(c.view),
      contextWindow: c.contextWindow ?? null,
      expect: expect(wire(contextUsage(c.view, c.contextWindow) ?? null)),
    })),
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
    resolveAgentDraft: AGENT_DRAFT_CASES.map((c) => ({
      name: c.name,
      agent: c.agent,
      agents: wire(c.agents),
      models: wire(c.models),
      defaults: wire(c.defaults),
      overrides: wire(c.overrides),
      expect: expect(
        wire(resolveAgentDraft(c.agent, c.agents, c.models as never, c.defaults as never, c.overrides as never)),
      ),
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

function skillBlocksVector(): VectorFile {
  // Skill cases are string content (a string never carries attachments); the
  // attachment cases exercise whole-block parsing.
  const cases: { name: string; content: UserContent }[] = [
    ...SKILL_BLOCK_CASES.map((c) => ({ name: c.name, content: c.text })),
    ...USER_BLOCK_CASES.map((c) => ({ name: c.name, content: c.content })),
  ];
  return write("skill-blocks", {
    stripUserBlocks: cases.map((c) => ({
      name: c.name,
      content: wire(c.content),
      expect: expect(wire(stripUserBlocks(c.content))),
    })),
  });
}

function skillMentionsVector(): VectorFile {
  return write("skill-mentions", {
    skillMentionRanges: SKILL_MENTION_CASES.map((c) => ({
      name: c.name,
      text: c.text,
      names: wire(c.names),
      expect: expect(wire(skillMentionRanges(c.text, [...c.names]))),
    })),
  });
}

function commandInputVector(): VectorFile {
  return write("command-input", {
    parseCommandInput: COMMAND_INPUT_CASES.map((c) => ({
      name: c.name,
      text: c.text,
      names: wire(c.names),
      expect: expect(wire(parseCommandInput(c.text, c.names.map((name) => ({ name }))) ?? null)),
    })),
  });
}

// ─── Account client (request building + response parsing are split — the
// Rust core does both, the platform owns the socket) ─────────────────────────

/** Records the request the client sent, answers with a canned 200. */
const captureFetch = () => {
  const calls: { url: string; init: AccountFetchInit | undefined }[] = [];
  const impl: AccountFetch = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve({
      status: 200,
      json: () => Promise.resolve({}),
      text: () => Promise.resolve("{}"),
    });
  };
  return { impl, calls };
};

/** Answers `status`; `body` is the raw text — `json()` parses it, rejecting (like real fetch) when it's absent or not JSON. */
const respondFetch = (status: number, body: string | null): AccountFetch => () =>
  Promise.resolve({
    status,
    json: async () => {
      if (body === null) throw new Error("empty body");
      return JSON.parse(body) as unknown;
    },
    text: async () => {
      if (body === null) throw new Error("empty body");
      return body;
    },
  });

const invokeOp = (client: AccountClient, op: AccountOpDesc): Promise<unknown> => {
  switch (op.kind) {
    case "login":
      return client.login(op.username, op.password, op.device);
    case "requestPairing":
      return client.requestPairing(op.hostId);
    case "me":
      return client.me();
    case "logout":
      return client.logout(op.revoke === undefined ? undefined : { revoke: op.revoke });
    case "revokeAllSessions":
      return client.revokeAllSessions();
    case "createJoinToken":
      return client.createJoinToken();
    case "listHosts":
      return client.listHosts();
    case "registerPushToken":
      return client.registerPushToken({ apns: op.apns, environment: op.environment });
    case "removePushToken":
      return client.removePushToken({ apns: op.apns, environment: op.environment });
    case "changePassword":
      return client.changePassword(op.currentPassword, op.newPassword);
    case "deleteAccount":
      return client.deleteAccount(op.password);
    case "listDevices":
      return client.listDevices();
    case "kickDevice":
      return client.kickDevice(op.id, op.password);
    case "lookupHostLink":
      return client.lookupHostLink(op.userCode);
    case "confirmHostLink":
      return client.confirmHostLink(op.userCode);
    case "denyHostLink":
      return client.denyHostLink(op.userCode);
  }
};

const bearerClient = (origin: string, token: string | undefined, fetchImpl: AccountFetch): AccountClient =>
  createAccountClient({
    origin,
    credentials: token === undefined ? { mode: "bearer" } : { mode: "bearer", token },
    fetch: fetchImpl,
  });

async function accountVector(): Promise<VectorFile> {
  const requests = await Promise.all(
    REQUEST_CASES.map(async (c) => {
      const { impl, calls } = captureFetch();
      await invokeOp(bearerClient(c.origin, c.token, impl), c.op);
      const call = calls[0]!;
      // `redirect: "manual"` is transport policy — the core's
      // AccountHttpRequest can't express it, the platform owns it there.
      const { redirect: _redirect, ...init } = call.init!;
      return { name: c.name, origin: c.origin, token: c.token ?? null, op: c.op, expect: wire({ url: call.url, init }) };
    }),
  );
  const responses = await Promise.all(
    RESPONSE_CASES.map(async (c) => {
      const op: AccountOpDesc =
        c.kind === "login"
          ? { kind: "login", username: "u", password: "p" }
          : c.kind === "requestPairing"
            ? { kind: "requestPairing", hostId: "h" }
            : c.kind === "registerPushToken" || c.kind === "removePushToken"
              ? { kind: c.kind, apns: "ab", environment: "production" }
              : c.kind === "changePassword"
                ? { kind: "changePassword", currentPassword: "a", newPassword: "b" }
                : c.kind === "deleteAccount"
                  ? { kind: "deleteAccount", password: "p" }
                  : c.kind === "kickDevice"
                    ? { kind: "kickDevice", id: 1, password: "p" }
                    : c.kind === "lookupHostLink" || c.kind === "confirmHostLink" || c.kind === "denyHostLink"
                      ? { kind: c.kind, userCode: "WDJB-MJHT" }
                      : { kind: c.kind };
      const result = await invokeOp(bearerClient("https://relay.example.com", "tok", respondFetch(c.status, c.body)), op);
      return { name: c.name, kind: c.kind, status: c.status, body: c.body, expect: wire(result) };
    }),
  );
  const probe = await Promise.all(
    PROBE_CASES.map(async (c) => {
      const impl: AccountFetch =
        c.status === null ? () => Promise.reject(new Error("ECONNREFUSED")) : respondFetch(c.status, c.body);
      return { name: c.name, status: c.status, body: c.body, expect: wire(await probeAccounts("https://relay.example.com", impl)) };
    }),
  );
  return write("account", {
    requests,
    responses,
    probe,
    probeRequest: await Promise.all(
      PROBE_REQUEST_CASES.map(async (c) => {
        const { impl, calls } = captureFetch();
        await probeAccounts(c.origin, impl);
        return { name: c.name, origin: c.origin, expect: wire(calls[0]!.url) };
      }),
    ),
    isSecureServerOrigin: SECURE_ORIGIN_CASES.map((c) => ({
      name: c.name,
      origin: c.origin,
      expect: wire(isSecureServerOrigin(c.origin)),
    })),
    normalizeServerOrigin: NORMALIZE_ORIGIN_CASES.map((c) => ({
      name: c.name,
      origin: c.origin,
      expect: wire(normalizeServerOrigin(c.origin)),
    })),
    matchAccountHosts: MATCH_CASES.map((c) => ({
      name: c.name,
      origin: c.origin,
      hosts: wire(c.hosts),
      stored: wire(c.stored),
      declined: wire(c.declined ?? []),
      storedRead: c.storedRead ?? true,
      expect: expect(wire(matchAccountHosts(c.origin, c.hosts, c.stored, c.declined ?? [], c.storedRead ?? true))),
    })),
    accountPairingFragment: OFFER_CASES.map((c) => ({
      name: c.name,
      offer: wire(c.offer),
      expect: wire(accountPairingFragment(c.offer) ?? null),
    })),
  });
}

export async function buildVectors(): Promise<VectorFile[]> {
  return [
    chatVector(),
    chatMetaVector(),
    toolsVector(),
    organizeVector(),
    familyVector(),
    modelsVector(),
    miscVector(),
    patchVector(),
    skillMentionsVector(),
    skillBlocksVector(),
    commandInputVector(),
    await accountVector(),
  ];
}
