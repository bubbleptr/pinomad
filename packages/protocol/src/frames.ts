import type { Op } from "@earendil-works/chord/delta";
import type { ConversationId, ModelRef } from "@earendil-works/pi-durable";
import type { Home, Project } from "./organization.ts";
import type { PresentationType } from "./presentation.ts";
import type { ModelSummary, Notice, SessionInfo } from "./view.ts";

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
  | "index";

export const conversationStream = (id: ConversationId): StreamName => `conversation:${id}`;
export const docStream = (kind: string, id: ConversationId): StreamName => `doc:${kind}:${id}`;

/** Close code for a rejected token; clients must not reconnect after it. */
export const UNAUTHORIZED_CLOSE_CODE = 4401;

export interface CallMethods {
  /** Register a local directory as a project; normalized and deduplicated host-side. */
  addProject: { args: { path: string }; result: Project };
  removeProject: { args: { path: string }; result: null };
  /** Create a top-level conversation at `home`, submit `text`, idempotent on `requestId`. */
  createConversation: {
    args: { home: Home; text: string; requestId: string };
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
  cycleThinking: { args: { conversationId: ConversationId }; result: null };
  /** A new ownerless conversation that sees this one's entries through `entryId`. */
  fork: {
    args: { conversationId: ConversationId; entryId: string; removeTools?: readonly string[] };
    result: { conversationId: ConversationId };
  };
  /** Answer a pending `pinomad.approval` request; `first` is true for the write that settled it. */
  decide: {
    args: { conversationId: ConversationId; kind: string; requestId: string; approved: boolean };
    result: { outcome: "approved" | "rejected" | "cancelled"; first: boolean };
  };
}

export type CallMethod = keyof CallMethods;

export type ServerFrame =
  | {
      readonly type: "hello";
      readonly session: SessionInfo;
      readonly models: readonly ModelSummary[];
      /** The conversation documents offered as `doc:` streams, in host order. */
      readonly docs: readonly { readonly kind: string; readonly presentation?: PresentationType }[];
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

/** JSON from a socket has no TypeScript guarantees; reject it before dispatch. */
export function isClientFrame(value: unknown): value is ClientFrame {
  if (!record(value)) return false;
  if (value.type === "subscribe" || value.type === "unsubscribe") {
    const stream = value.stream;
    return (
      typeof stream === "string"
      && (stream === "tasks" || stream === "conversations" || stream === "index" || /^(?:conversation:|doc:.+:)[1-9]\d*$/.test(stream))
    );
  }
  if (value.type !== "call" || !Number.isSafeInteger(value.id) || !record(value.args)) return false;
  const args = value.args;
  const conversationId = (): boolean =>
    typeof args.conversationId === "number" && Number.isSafeInteger(args.conversationId) && args.conversationId >= 1;
  switch (value.method) {
    case "submit":
      return (
        conversationId() && typeof args.text === "string" && (args.whenBusy === "steer" || args.whenBusy === "followUp")
        && nonempty(args.requestId)
      );
    case "abort":
    case "cycleThinking":
      return conversationId();
    case "compact":
      return conversationId() && (args.instructions === undefined || typeof args.instructions === "string");
    case "setModel":
      return conversationId() && record(args.model) && nonempty(args.model.provider) && nonempty(args.model.modelId);
    case "fork":
      return (
        conversationId() && typeof args.entryId === "string" && /^[1-9]\d*$/.test(args.entryId)
        && (args.removeTools === undefined || (Array.isArray(args.removeTools) && args.removeTools.every(nonempty)))
      );
    case "decide":
      return conversationId() && nonempty(args.kind) && nonempty(args.requestId) && typeof args.approved === "boolean";
    case "addProject":
    case "removeProject":
      return nonempty(args.path);
    case "createConversation":
      return (
        record(args.home) && (args.home.kind === "chat" || (args.home.kind === "project" && nonempty(args.home.path)))
        && nonempty(args.text) && nonempty(args.requestId)
      );
    case "archive":
      return conversationId() && typeof args.archived === "boolean";
    default:
      return false;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
