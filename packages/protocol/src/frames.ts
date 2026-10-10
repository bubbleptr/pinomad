import type { Op } from "@earendil-works/chord/delta";
import type { ConversationId, ModelRef } from "@earendil-works/pi-durable";
import type { Home, Project } from "./organization.ts";
import type { PresentationType, QuestionAnswer } from "./presentation.ts";
import type { ConversationDefaults, ModelSummary, Notice, SessionInfo, ThinkingLevel } from "./view.ts";

/**
 * A subscribable value: one conversation's view, one of its documents (`null`
 * while absent), the task graph, or the conversation list. A subscription
 * starts with a snapshot; ops follow and apply to it with chord's
 * `applyImmutable`.
 */
export type StreamName =
  | `conversation:${ConversationId}`
  | `doc:${string}:${ConversationId}`
  | "tasks"
  | "conversations"
  | "index"
  | "devices"
  | "mcp";

export const conversationStream = (id: ConversationId): StreamName => `conversation:${id}`;
export const docStream = (kind: string, id: ConversationId): StreamName => `doc:${kind}:${id}`;

/** Close code for a rejected token; clients must not reconnect after it. */
export const UNAUTHORIZED_CLOSE_CODE = 4401;

/**
 * Close code for a malformed client frame, an application-range code;
 * clients must not reconnect after it — the next attempt sends the same
 * frames. Deliberately not 1008: secure-channel failures (handshake timeout,
 * corrupt record) also close with 1008 and must stay reconnectable.
 */
export const INVALID_FRAME_CLOSE_CODE = 4400;

/** The version a hello announces: `major` decides compatibility, `minor` the features the host has. */
export interface ProtocolVersion {
  readonly major: number;
  readonly minor: number;
}

/**
 * The protocol this build speaks (ADR-0018). Within a major version only
 * additive changes are allowed — optional fields, new calls, streams, frame
 * and presentation types — and each addition bumps `minor`; a client gates a
 * feature on the host's `minor` covering it (a `since` table is added here
 * with the first minor bump). `major` differs → the two cannot talk.
 */
export const PROTOCOL: ProtocolVersion = { major: 5, minor: 0 };

export interface CallMethods {
  /** Register a local directory as a project; normalized and deduplicated host-side. */
  addProject: { args: { path: string }; result: Project };
  removeProject: { args: { path: string }; result: null };
  /**
   * Create a top-level conversation at `home`, submit `text`, idempotent on `requestId`.
   * `checkout`: project conversations default to a git worktree when the project
   * is in a repository; `"project"` works directly in the project directory.
   */
  createConversation: {
    args: {
      home: Home;
      text: string;
      requestId: string;
      checkout?: "worktree" | "project";
      /** Overrides the host's defaults for the new agent; the level clamps to the model. */
      model?: ModelRef;
      thinkingLevel?: ThinkingLevel;
    };
    result: { conversationId: ConversationId };
  };
  archive: { args: { conversationId: ConversationId; archived: boolean }; result: null };
  submit: {
    args: {
      conversationId: ConversationId;
      text: string;
      whenBusy: "steer" | "followUp";
      /** Makes a resend after a lost reply admit nothing new. */
      requestId: string;
    };
    result: { submissionId: string };
  };
  abort: { args: { conversationId: ConversationId }; result: null };
  compact: { args: { conversationId: ConversationId; instructions?: string }; result: { taskId: string } };
  setModel: { args: { conversationId: ConversationId; model: ModelRef }; result: null };
  /** Set the agent's thinking level; rejects when the model doesn't support it. */
  setThinkingLevel: { args: { conversationId: ConversationId; level: ThinkingLevel }; result: null };
  /** A new ownerless conversation that sees this one's entries through `entryId`. */
  fork: {
    args: { conversationId: ConversationId; entryId: string; removeTools?: readonly string[] };
    result: { conversationId: ConversationId };
  };
  /** Answer a pending `pinomad.question` request; `first` is true for the write that settled it. */
  answer: {
    args: { conversationId: ConversationId; kind: string; requestId: string; answers: QuestionAnswer[] };
    result: { first: boolean };
  };
  /**
   * The shown conversation's file changes as a unified patch: a worktree diff
   * vs its base commit, or a project directory's uncommitted diff vs HEAD.
   */
  changes: {
    args: { conversationId: ConversationId };
    result: { available: false; reason: string } | { available: true; base: string; patch: string; truncated: boolean };
  };
  /** A one-time pairing offer; `url` carries the host public key and the secret. */
  createPairing: { args: Record<string, never>; result: { url: string; expiresAt: number } };
  /** Forget a paired device and drop its live connections. */
  revokeDevice: { args: { publicKey: string }; result: null };
}

export type CallMethod = keyof CallMethods;

export type ServerFrame =
  | {
      readonly type: "hello";
      readonly protocol: ProtocolVersion;
      /** Packaged release version; absent in a source checkout. */
      readonly hostVersion?: string;
      readonly session: SessionInfo;
      readonly models: readonly ModelSummary[];
      /** New-conversation defaults; absent means the host has none. */
      readonly defaults?: ConversationDefaults;
      /** The conversation documents offered as `doc:` streams, in host order. */
      readonly docs: readonly { readonly kind: string; readonly presentation?: PresentationType }[];
      /** How to render each tool's result `details` (ADR-0005); absent names never declare one. */
      readonly toolPresentations: Record<string, PresentationType>;
    }
  | { readonly type: "snapshot"; readonly stream: StreamName; readonly value: unknown }
  | { readonly type: "ops"; readonly stream: StreamName; readonly ops: readonly Op[] }
  /** The stream will send nothing more, for example an unknown conversation. */
  | { readonly type: "ended"; readonly stream: StreamName; readonly reason: string }
  | { readonly type: "result"; readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly type: "result"; readonly id: number; readonly ok: false; readonly error: string }
  | { readonly type: "notice"; readonly level: Notice["level"]; readonly message: string };

export type ClientFrame =
  | { readonly type: "subscribe"; readonly stream: StreamName }
  | { readonly type: "unsubscribe"; readonly stream: StreamName }
  | {
      [M in CallMethod]: {
        readonly type: "call";
        readonly id: number;
        readonly method: M;
        readonly args: CallMethods[M]["args"];
      };
    }[CallMethod];

/**
 * What an inbound client frame turned out to be (ADR-0018 §3): a frame to
 * dispatch, something this host predates (`unsupported*`, answered with an
 * error instead of a disconnect), a frame type to ignore, or `malformed` —
 * malformed means the sender is buggy, so the socket is closed.
 */
export type ParsedClientFrame =
  | { readonly kind: "frame"; readonly frame: ClientFrame }
  | { readonly kind: "unsupportedCall"; readonly id: number; readonly method: string }
  | { readonly kind: "unsupportedStream"; readonly type: "subscribe" | "unsubscribe"; readonly stream: string }
  | { readonly kind: "unknownType" }
  | { readonly kind: "malformed" };

/** JSON from a socket has no TypeScript guarantees; classify it before dispatch. */
export function parseClientFrame(value: unknown): ParsedClientFrame {
  if (!record(value) || typeof value.type !== "string") return { kind: "malformed" };
  if (value.type === "subscribe" || value.type === "unsubscribe") {
    const stream = value.stream;
    if (typeof stream !== "string") return { kind: "malformed" };
    if (isStreamName(stream)) {
      return { kind: "frame", frame: { type: value.type, stream } };
    }
    // A name under a known stream kind is a malformed frame; anything else is
    // a stream this host predates.
    const prefix = stream.slice(0, stream.indexOf(":") === -1 ? undefined : stream.indexOf(":"));
    if (STREAM_KINDS.has(prefix)) return { kind: "malformed" };
    return { kind: "unsupportedStream", type: value.type, stream };
  }
  if (value.type !== "call") return { kind: "unknownType" };
  const { id, method, args } = value;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || !record(args) || typeof method !== "string") {
    return { kind: "malformed" };
  }
  if (!isCallMethod(method)) return { kind: "unsupportedCall", id, method };
  return validCallArgs(method, args)
    ? { kind: "frame", frame: { type: "call", id, method, args } as ClientFrame }
    : { kind: "malformed" };
}

/** Every stream name's kind: fixed names plus the `conversation:`/`doc:` prefixes. */
const STREAM_KINDS = new Set(["conversation", "doc", "tasks", "conversations", "index", "devices", "mcp"]);

function isStreamName(stream: string): stream is StreamName {
  return (
    stream === "tasks"
    || stream === "conversations"
    || stream === "index"
    || stream === "devices"
    || stream === "mcp"
    || /^(?:conversation:|doc:.+:)[1-9]\d*$/.test(stream)
  );
}

const isCallMethod = (method: string): method is CallMethod =>
  (CALL_METHODS as readonly string[]).includes(method);

/** Call names kept in sync with CallMethods; the switch below validates their args. */
const CALL_METHODS = [
  "addProject",
  "removeProject",
  "createConversation",
  "archive",
  "submit",
  "abort",
  "compact",
  "setModel",
  "setThinkingLevel",
  "fork",
  "answer",
  "changes",
  "createPairing",
  "revokeDevice",
] as const satisfies readonly CallMethod[];

function validCallArgs(method: CallMethod, args: Record<string, unknown>): boolean {
  const conversationId = (): boolean =>
    typeof args.conversationId === "number" && Number.isSafeInteger(args.conversationId) && args.conversationId >= 1;
  switch (method) {
    case "submit":
      return (
        conversationId() && typeof args.text === "string" && (args.whenBusy === "steer" || args.whenBusy === "followUp")
        && nonempty(args.requestId)
      );
    case "abort":
      return conversationId();
    case "setThinkingLevel":
      return conversationId() && nonempty(args.level);
    case "compact":
      return conversationId() && (args.instructions === undefined || typeof args.instructions === "string");
    case "setModel":
      return conversationId() && record(args.model) && nonempty(args.model.provider) && nonempty(args.model.modelId);
    case "fork":
      return (
        conversationId() && typeof args.entryId === "string" && /^[1-9]\d*$/.test(args.entryId)
        && (args.removeTools === undefined || (Array.isArray(args.removeTools) && args.removeTools.every(nonempty)))
      );
    case "answer":
      return (
        conversationId() && nonempty(args.kind) && nonempty(args.requestId) && Array.isArray(args.answers)
        && args.answers.every(
          (answer) =>
            record(answer) && Array.isArray(answer.selected) && answer.selected.every((l) => typeof l === "string")
            && (answer.other === undefined || typeof answer.other === "string"),
        )
      );
    case "changes":
      return conversationId();
    case "addProject":
    case "removeProject":
      return nonempty(args.path);
    case "createConversation":
      return (
        record(args.home) && (args.home.kind === "chat" || (args.home.kind === "project" && nonempty(args.home.path)))
        && nonempty(args.text) && nonempty(args.requestId)
        && (args.checkout === undefined || args.checkout === "worktree" || args.checkout === "project")
        && (args.model === undefined || (record(args.model) && nonempty(args.model.provider) && nonempty(args.model.modelId)))
        && (args.thinkingLevel === undefined || nonempty(args.thinkingLevel))
      );
    case "archive":
      return conversationId() && typeof args.archived === "boolean";
    case "createPairing":
      return Object.keys(args).length === 0;
    case "revokeDevice":
      return nonempty(args.publicKey) && /^[A-Za-z0-9_-]+$/.test(args.publicKey);
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
