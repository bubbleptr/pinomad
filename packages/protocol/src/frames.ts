import type { Op } from "@earendil-works/chord/delta";
import type { ConversationId, ModelRef } from "@earendil-works/pi-durable";
import type { AgentRole, AgentRoles } from "./agents.ts";
import type { HostAuth } from "./auth.ts";
import type { MessageImage } from "./images.ts";
import type { HostDevices } from "./devices.ts";
import type { McpStatus } from "./mcp.ts";
import type { FileListing, FileScope, FolderListing, Home, HostIndex, Project } from "./organization.ts";
import type { PresentationType, QuestionAnswer } from "./presentation.ts";
import type { ApnsEnvironment } from "./relay.ts";
import {
  HOST_SETTING_KEYS,
  isQueueMode,
  isThinkingLevel,
  type HostSettingKey,
  type HostSettings,
  type HostSettingsPatch,
} from "./settings.ts";
import type {
  ConversationDefaults,
  ConversationSummary,
  ModelSummary,
  Notice,
  SessionInfo,
  ThinkingLevel,
} from "./view.ts";

/** Value carried by each host-level stream every client subscribes to on connect. */
export interface HostStreamValues {
  conversations: readonly ConversationSummary[];
  index: HostIndex;
  devices: HostDevices;
  mcp: McpStatus | null;
  models: readonly ModelSummary[];
  auth: HostAuth;
  settings: HostSettings;
  /** Named agents (ADR-0023): `roles` and the `problems` of files that didn't parse. */
  agents: AgentRoles;
}

export type HostStreamName = keyof HostStreamValues;

/** Minor version that introduced each host stream (ADR-0018 §2); every client subscribes to the ones its host's minor covers. */
const HOST_STREAMS = { conversations: 0, index: 0, devices: 0, mcp: 0, models: 1, auth: 1, settings: 2, agents: 6 } satisfies Record<
  HostStreamName,
  number
>;
export const HOST_STREAM_NAMES = Object.keys(HOST_STREAMS) as readonly HostStreamName[];

/** The host streams a host of the given minor version knows. */
export function hostStreams(hostMinor: number): readonly HostStreamName[] {
  return HOST_STREAM_NAMES.filter((name) => HOST_STREAMS[name] <= hostMinor);
}

/**
 * A subscribable value: a host-level stream from `HostStreamValues`, one
 * conversation's view, one of its documents (`null` while absent), or the
 * task graph. A subscription starts with a snapshot; ops follow and apply
 * to it with chord's `applyImmutable`.
 */
export type StreamName = `conversation:${ConversationId}` | `doc:${string}:${ConversationId}` | "tasks" | HostStreamName;

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
 * feature on the host's `minor` covering it (the `since` tables are
 * `HOST_STREAMS` and `CALL_SINCE` below). `major` differs → the two cannot
 * talk.
 */
export const PROTOCOL: ProtocolVersion = { major: 5, minor: 12 };

export interface CallMethods {
  /** Register a local directory as a project; normalized and deduplicated host-side. */
  addProject: { args: { path: string }; result: Project };
  removeProject: { args: { path: string }; result: null };
  /**
   * List a host directory's visible subfolders; no `path` lists the host
   * user's home. Hosts are POSIX-only, so paths are `/`-separated.
   */
  listFolders: { args: { path?: string }; result: FolderListing };
  /**
   * File candidates under a scope's root for `@./path` completion (5.10).
   * Read-only and unsorted — `files` are `/`-separated paths relative to the
   * root, `truncated` marks any enumeration or result cap the answer hit.
   */
  listFiles: { args: { scope: FileScope; query: string }; result: FileListing };
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
      /** A named agent to create the conversation with (ADR-0023). Needs a 5.10 host — older hosts ignore the field. */
      agent?: string;
      /** Up to 4; checked by the host (imageProblem). Needs a 5.5 host — older hosts ignore the field. */
      images?: readonly MessageImage[];
    };
    result: { conversationId: ConversationId };
  };
  archive: { args: { conversationId: ConversationId; archived: boolean }; result: null };
  /** Set the conversation's name permanently: after a manual rename the host never auto-titles it again. */
  renameConversation: { args: { conversationId: ConversationId; title: string }; result: null };
  submit: {
    args: {
      conversationId: ConversationId;
      text: string;
      whenBusy: "steer" | "followUp";
      /** Makes a resend after a lost reply admit nothing new. */
      requestId: string;
      /** Up to 4; checked by the host (imageProblem). Needs a 5.5 host — older hosts ignore the field. */
      images?: readonly MessageImage[];
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
   * `branch` (5.11) is the checkout directory's current branch — omitted for
   * detached HEAD, non-git directories, and Chat conversations; both result
   * shapes carry it since an unborn branch still names one without a diff.
   */
  changes: {
    args: { conversationId: ConversationId };
    result:
      | { available: false; reason: string; branch?: string }
      | { available: true; base: string; patch: string; truncated: boolean; branch?: string };
  };
  /** A one-time pairing offer; `url` carries the host public key and the secret. */
  createPairing: { args: Record<string, never>; result: { url: string; expiresAt: number } };
  /** Forget a paired device and drop its live connections. */
  revokeDevice: { args: { publicKey: string }; result: null };
  /** Remove a provider's stored credential; also logs the Pi CLI on this machine out (ADR-0021 §5). */
  logout: { args: { providerId: string }; result: null };
  /** Patch the host's settings (ADR-0021); each key set lands in PiNomad's settings.json, each `null` resets to fallback. */
  updateSettings: { args: { patch: HostSettingsPatch }; result: null };
  /** Create `<name>.md` under the host's agents dir; fails when it already exists. */
  createAgent: { args: { role: AgentRole }; result: null };
  /** Overwrite `<name>.md` — also how a broken file gets fixed. Renaming is create + delete; `role.name` must match the file. */
  updateAgent: { args: { role: AgentRole }; result: null };
  /** Delete `<name>.md`; fails when it does not exist. */
  deleteAgent: { args: { name: string }; result: null };
  /**
   * Register this device's APNs push token on the host (`null` deregisters);
   * secure-channel clients only — the token lands under the connection's own
   * device key. Idempotent. Needs a 5.7 host; the `apns` object form needs a
   * 5.9 host (`apnsPush` in FEATURE_SINCE). Legacy Expo token strings still
   * parse but answer `ok:false` — push no longer goes through Expo (ADR-0025
   * §7). Malformed shapes close with 4400.
   */
  setPushToken: { args: { token: PushToken | null }; result: null };
}

/** APNs device-token registration (ADR-0025 §7, protocol 5.9). */
export interface ApnsPushToken {
  /** The device token APNs issued, hex — Apple does not fix its length. */
  readonly apns: string;
  /** Matches the build's `aps-environment` entitlement. */
  readonly environment: ApnsEnvironment;
}

/**
 * `setPushToken` argument: an APNs registration, a legacy Expo token string
 * (parses, but the host refuses it — Expo push is retired), or `null`.
 */
export type PushToken = string | ApnsPushToken;

export type CallMethod = keyof CallMethods;

/** Minor version that introduced each call; calls absent here date from 5.0. */
const CALL_SINCE: Partial<Record<CallMethod, number>> = {
  logout: 1,
  updateSettings: 2,
  listFolders: 3,
  renameConversation: 4,
  createAgent: 6,
  updateAgent: 6,
  deleteAgent: 6,
  setPushToken: 7,
  listFiles: 10,
};

/** Whether a host of the given minor version knows `method`. */
export function hostSupportsCall(hostMinor: number, method: CallMethod): boolean {
  return hostMinor >= (CALL_SINCE[method] ?? 0);
}

/** Minor version that introduced each call-arg feature (ADR-0018 §2). */
const FEATURE_SINCE = {
  images: 5,
  acceptAccountDevices: 8,
  apnsPush: 9,
  agentConversations: 10,
  liveBranch: 11,
  /** `settings`/`updateSettings` carry the host's machine display name (12). */
  hostName: 12,
} as const;
export type HostFeature = keyof typeof FEATURE_SINCE;

/** Whether a host of the given minor version honors `feature`. */
export function hostSupportsFeature(hostMinor: number, feature: HostFeature): boolean {
  return hostMinor >= FEATURE_SINCE[feature];
}

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
const STREAM_KINDS = new Set(["conversation", "doc", "tasks", ...HOST_STREAM_NAMES]);

function isStreamName(stream: string): stream is StreamName {
  return (
    stream === "tasks"
    || (HOST_STREAM_NAMES as readonly string[]).includes(stream)
    || /^(?:conversation:|doc:.+:)[1-9]\d*$/.test(stream)
  );
}

const isCallMethod = (method: string): method is CallMethod =>
  (CALL_METHODS as readonly string[]).includes(method);

/** Call names kept in sync with CallMethods; the switch below validates their args. */
const CALL_METHODS = [
  "addProject",
  "removeProject",
  "listFolders",
  "createConversation",
  "archive",
  "renameConversation",
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
  "logout",
  "updateSettings",
  "createAgent",
  "updateAgent",
  "deleteAgent",
  "setPushToken",
  "listFiles",
] as const satisfies readonly CallMethod[];

const SETTING_VALIDATORS: Record<HostSettingKey, (value: unknown) => boolean> = {
  defaultModel: (value) => value === null || (record(value) && nonempty(value.provider) && nonempty(value.modelId)),
  defaultThinkingLevel: (value) => value === null || isThinkingLevel(value),
  steeringMode: (value) => value === null || isQueueMode(value),
  followUpMode: (value) => value === null || isQueueMode(value),
  acceptAccountDevices: (value) => value === null || typeof value === "boolean",
  // Shape only — the host re-checks content anyway (cleanHostName).
  hostName: (value) => value === null || typeof value === "string",
};

function validCallArgs(method: CallMethod, args: Record<string, unknown>): boolean {
  const conversationId = (): boolean =>
    typeof args.conversationId === "number" && Number.isSafeInteger(args.conversationId) && args.conversationId >= 1;
  // Shape only — count, mime type, base64 and size limits are the host's check (imageProblem).
  const images = (): boolean =>
    args.images === undefined
    || (Array.isArray(args.images)
      && args.images.every((image) => record(image) && typeof image.data === "string" && typeof image.mimeType === "string"));
  // Shape only — name/description/model rules are the host's check (agentRoleProblem).
  const role = (): boolean =>
    record(args.role)
    && typeof args.role.name === "string"
    && typeof args.role.description === "string"
    && typeof args.role.prompt === "string"
    && (args.role.model === undefined || typeof args.role.model === "string")
    && (args.role.thinkingLevel === undefined || typeof args.role.thinkingLevel === "string");
  switch (method) {
    case "submit":
      return (
        conversationId() && typeof args.text === "string" && (args.whenBusy === "steer" || args.whenBusy === "followUp")
        && nonempty(args.requestId) && images()
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
    case "listFolders":
      // Absoluteness is the host's check — the frame only needs a usable name.
      return args.path === undefined || nonempty(args.path);
    case "createConversation":
      return (
        record(args.home) && (args.home.kind === "chat" || (args.home.kind === "project" && nonempty(args.home.path)))
        && typeof args.text === "string" && (nonempty(args.text) || (Array.isArray(args.images) && args.images.length > 0))
        && nonempty(args.requestId) && images()
        && (args.checkout === undefined || args.checkout === "worktree" || args.checkout === "project")
        && (args.model === undefined || (record(args.model) && nonempty(args.model.provider) && nonempty(args.model.modelId)))
        && (args.thinkingLevel === undefined || nonempty(args.thinkingLevel))
        && (args.agent === undefined || nonempty(args.agent))
      );
    case "listFiles":
      // Shape only — unknown conversations/projects and bad checkouts are the
      // host's `ok:false` business errors, not malformed frames (ADR-0018 §3).
      return (
        typeof args.query === "string"
        && record(args.scope)
        && ((args.scope.kind === "conversation"
            && typeof args.scope.conversationId === "number"
            && Number.isSafeInteger(args.scope.conversationId)
            && args.scope.conversationId >= 1)
          || (args.scope.kind === "project"
            && nonempty(args.scope.path)
            && (args.scope.checkout === "worktree" || args.scope.checkout === "project")))
      );
    case "archive":
      return conversationId() && typeof args.archived === "boolean";
    case "renameConversation":
      return conversationId() && typeof args.title === "string";
    case "createPairing":
      return Object.keys(args).length === 0;
    case "revokeDevice":
      return nonempty(args.publicKey) && /^[A-Za-z0-9_-]+$/.test(args.publicKey);
    case "logout":
      return nonempty(args.providerId);
    case "createAgent":
    case "updateAgent":
      return role();
    case "deleteAgent":
      return typeof args.name === "string";
    case "setPushToken":
      // Shape only — the APNs hex format and length are the host's check; the
      // legacy string form still parses so its refusal is an `ok:false`
      // answer, not a 4400 (ADR-0025 §7).
      return (
        args.token === null ||
        typeof args.token === "string" ||
        (record(args.token) &&
          typeof args.token.apns === "string" &&
          (args.token.environment === "production" || args.token.environment === "development"))
      );
    case "updateSettings":
      // An empty patch is valid; an unknown key is malformed, never silently dropped.
      return (
        record(args.patch)
        && Object.keys(args.patch).every((key) => (HOST_SETTING_KEYS as readonly string[]).includes(key))
        && Object.entries(args.patch).every(([key, value]) =>
          (SETTING_VALIDATORS as Record<string, (value: unknown) => boolean>)[key]?.(value) === true,
        )
      );
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
