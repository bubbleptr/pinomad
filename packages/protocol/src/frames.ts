import type { Op } from "@earendil-works/chord/delta";
import type { ConversationId, ModelRef } from "@earendil-works/pi-durable";
import type { AgentRole, AgentRoles } from "./agents.ts";
import { isCustomProviderApi, type CustomProviderApi, type CustomProviderInput, type HostAuth, type HostProviders, type LoginMethod } from "./auth.ts";
import type { EndpointSet } from "./endpoints.ts";
import type { ImageResult, OutgoingImage } from "./images.ts";
import type { HostDevices } from "./devices.ts";
import type { McpStatus } from "./mcp.ts";
import type { CommandListing } from "./commands.ts";
import type { FileListing, FileScope, FolderListing, Home, HostIndex, Project, SkillListing, SkillScope } from "./organization.ts";
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
  /** Every provider, its login methods and credential state, and logins in progress (5.21, ADR-0031). */
  providers: HostProviders;
  settings: HostSettings;
  /** Named agents (ADR-0023): `roles` and the `problems` of files that didn't parse. */
  agents: AgentRoles;
}

export type HostStreamName = keyof HostStreamValues;

/** Minor version that introduced each host stream (ADR-0018 §2); every client subscribes to the ones its host's minor covers. */
export const HOST_STREAMS = { conversations: 0, index: 0, devices: 0, mcp: 0, models: 1, auth: 1, settings: 2, agents: 6, providers: 21 } satisfies Record<
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
export const PROTOCOL: ProtocolVersion = { major: 5, minor: 22 };

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
   * The `$`-mentionable skills in a scope (5.13): the same Skills the scope's
   * system prompt would list, minus the names the composer can't type (ADR-0006
   * loads names that fail upstream validation — they stay prompt-only).
   * Read-only, sent outside the command queue like `listFiles`.
   */
  listSkills: { args: { scope: SkillScope }; result: SkillListing };
  /**
   * The slash commands a conversation's composer may offer (5.17, ADR-0029).
   * Read-only, sent outside the command queue like `listSkills`.
   */
  listCommands: { args: { conversationId: ConversationId }; result: CommandListing };
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
      /**
       * Up to 4; checked by the host (imageProblem). Needs a 5.5 host — older hosts ignore the field;
       * `{ ref }` entries need a 5.15 host (`imageRefs` in FEATURE_SINCE).
       */
      images?: readonly OutgoingImage[];
      /**
       * The skills the user picked from the `$` menu, deduplicated, in mention
       * order (5.16, ADR-0028; `boundSkills` in FEATURE_SINCE). The host
       * expands exactly these into the message — `[]` expands nothing; absent
       * (an older client) falls back to matching `$name` in the text.
       */
      skills?: readonly string[];
      /**
       * Host-stored attachments to reference (5.19, issue #321), at most
       * MAX_ATTACHMENTS_PER_MESSAGE. Needs a 5.19 host; an older host would
       * call the field malformed and 4400 the connection.
       */
      attachments?: readonly string[];
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
      /**
       * Up to 4; checked by the host (imageProblem). Needs a 5.5 host — older hosts ignore the field;
       * `{ ref }` entries need a 5.15 host (`imageRefs` in FEATURE_SINCE).
       */
      images?: readonly OutgoingImage[];
      /**
       * The skills the user picked from the `$` menu, deduplicated, in mention
       * order (5.16, ADR-0028; `boundSkills` in FEATURE_SINCE). The host
       * expands exactly these into the message — `[]` expands nothing; absent
       * (an older client) falls back to matching `$name` in the text.
       */
      skills?: readonly string[];
      /**
       * Host-stored attachments to reference (5.19, issue #321), at most
       * MAX_ATTACHMENTS_PER_MESSAGE. Needs a 5.19 host; an older host would
       * call the field malformed and 4400 the connection.
       */
      attachments?: readonly string[];
    };
    result: { submissionId: number };
  };
  /**
   * Start a file upload (5.19, issue #321) and get the host-generated id.
   * Unbound and unqueued like `listFiles`, so a draft may upload before its
   * first message exists. `size` is the decoded byte count.
   */
  beginAttachment: { args: { name: string; size: number }; result: { attachmentId: string } };
  /**
   * Append one base64 chunk (decoded at most 512 KiB) at `offset` (5.19).
   * Serialized per attachment host-side; `received` is the file's current
   * length, so a retry after a lost reply resends from there. A complete or
   * used attachment answers `{ received: size, complete: true }` regardless
   * of `offset`.
   */
  appendAttachment: {
    args: { attachmentId: string; offset: number; data: string };
    result: { received: number; complete: boolean };
  };
  /**
   * The bytes behind an image ref (5.15, ADR-0027). Answers only refs this
   * connection's live `images: "ref"` subscriptions carried; a ref from a
   * stream since unsubscribed is an `ok:false`. Derived variants are 5.20;
   * the result reports the variant actually returned, absent means original.
   */
  image: { args: { ref: string; variant?: "thumbnail" | "preview" }; result: ImageResult };
  /**
   * Take a queued input back out of the inbox (5.14). `sent`: it already
   * reached the transcript.
   */
  withdrawQueued: {
    args: { conversationId: ConversationId; submissionId: number };
    result: { outcome: "withdrawn" | "sent" };
  };
  /**
   * Promote a queued follow-up to steer in place (5.14); it is placed at the
   * next boundary that takes steers, in queue order. `steered` does not promise
   * an immediate placement: one-at-a-time steering takes only the earliest
   * steer at each boundary.
   */
  steerQueued: {
    args: { conversationId: ConversationId; submissionId: number };
    result: { outcome: "steered" | "sent" | "unavailable" };
  };
  abort: { args: { conversationId: ConversationId }; result: null };
  compact: { args: { conversationId: ConversationId; instructions?: string }; result: { taskId: string } };
  /**
   * Run a host-declared command by its listed `name` (5.17, ADR-0029); `args`
   * is the text after it. An unknown name fails the call. Mutating, so the
   * client queues it behind earlier commands like `compact`.
   */
  runCommand: { args: { conversationId: ConversationId; name: string; args?: string }; result: null };
  setModel: { args: { conversationId: ConversationId; model: ModelRef }; result: null };
  /** Set the agent's thinking level; rejects when the model doesn't support it. */
  setThinkingLevel: { args: { conversationId: ConversationId; level: ThinkingLevel }; result: null };
  /**
   * Switch the conversation to a named agent (5.18, ADR-0023): the role's
   * prompt and any model/thinking-level pins are re-copied from the current
   * file; `null` clears the prompt and keeps the current model. Subagents
   * reject the call — their role is fixed by the delegating call.
   */
  setAgent: { args: { conversationId: ConversationId; agent: string | null }; result: null };
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
  /** Remove a provider's stored credential (ADR-0031: the host's own `auth.json`, not pi's). */
  logout: { args: { providerId: string }; result: null };
  /**
   * Start logging in to a provider (5.21, ADR-0031). The flow shows up in the
   * `providers` stream's `logins`, where its prompts and events arrive;
   * rejects when the provider lacks `method` or already has a login running.
   */
  beginLogin: { args: { providerId: string; method: LoginMethod }; result: { loginId: string } };
  /** Answer a running login's current prompt; a stale `promptId` is rejected, never applied to a later prompt. */
  answerLogin: { args: { loginId: string; promptId: number; value: string }; result: null };
  /** Abort a running login; ended or unknown ids are a no-op. */
  cancelLogin: { args: { loginId: string }; result: null };
  /**
   * Add or replace a custom endpoint (5.21). `apiKey` stores a key, `null`
   * removes the stored one, absent keeps it.
   */
  saveCustomProvider: { args: { provider: CustomProviderInput; apiKey?: string | null }; result: null };
  /** Remove a custom endpoint and its stored key. */
  removeCustomProvider: { args: { providerId: string }; result: null };
  /**
   * Ask an endpoint which models it serves, from the host — the endpoint may
   * be reachable only there. `providerId` reuses that custom endpoint's stored
   * key when `apiKey` is absent.
   */
  listEndpointModels: {
    args: { api: CustomProviderApi; baseUrl: string; apiKey?: string; providerId?: string };
    result: { models: readonly string[] };
  };
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

/**
 * Minor version that introduced each call (ADR-0018 §2); calls dated 0 are
 * part of 5.0. This is the single exhaustive call table: a new `CallMethods`
 * entry without a row fails type checking, and the Rust vectors carry every
 * row so the Rust mirror cannot silently fall back to 5.0.
 */
export const CALL_SINCE: Record<CallMethod, number> = {
  addProject: 0,
  removeProject: 0,
  listFolders: 3,
  listFiles: 10,
  listSkills: 13,
  listCommands: 17,
  createConversation: 0,
  archive: 0,
  renameConversation: 4,
  submit: 0,
  withdrawQueued: 14,
  steerQueued: 14,
  abort: 0,
  compact: 0,
  runCommand: 17,
  setModel: 0,
  setThinkingLevel: 0,
  setAgent: 18,
  fork: 0,
  answer: 0,
  changes: 0,
  createPairing: 0,
  revokeDevice: 0,
  logout: 1,
  beginLogin: 21,
  answerLogin: 21,
  cancelLogin: 21,
  saveCustomProvider: 21,
  removeCustomProvider: 21,
  listEndpointModels: 21,
  updateSettings: 2,
  createAgent: 6,
  updateAgent: 6,
  deleteAgent: 6,
  setPushToken: 7,
  image: 15,
  beginAttachment: 19,
  appendAttachment: 19,
};

/** Whether a host of the given minor version knows `method`. */
export function hostSupportsCall(hostMinor: number, method: CallMethod): boolean {
  return hostMinor >= CALL_SINCE[method];
}

/** Minor version that introduced each call-arg feature (ADR-0018 §2). */
export const FEATURE_SINCE = {
  images: 5,
  acceptAccountDevices: 8,
  apnsPush: 9,
  agentConversations: 10,
  liveBranch: 11,
  /** `settings`/`updateSettings` carry the host's machine display name (12). */
  hostName: 12,
  /** `submit`/`createConversation` images may be `{ ref }` (15); an older host calls them malformed and 4400s. */
  imageRefs: 15,
  /** `submit`/`createConversation` carry `skills`, the `$` picks to expand (16); an older host ignores the field. */
  boundSkills: 16,
  /** `submit`/`createConversation` carry `attachments`, host-stored ids (19); an older host 4400s the field. */
  attachments: 19,
  /** `image` accepts derived variants and reports the actual variant (20); older hosts return original. */
  imageVariants: 20,
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
      /**
       * The host's current remote candidates (5.22, ADR-0032). Absent means an
       * older host and never clears a stored set; a present valid set — including
       * an empty one — replaces it.
       */
      readonly endpointSet?: EndpointSet;
    }
  | { readonly type: "snapshot"; readonly stream: StreamName; readonly value: unknown }
  | { readonly type: "ops"; readonly stream: StreamName; readonly ops: readonly Op[] }
  /** The stream will send nothing more, for example an unknown conversation. */
  | { readonly type: "ended"; readonly stream: StreamName; readonly reason: string }
  | { readonly type: "result"; readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly type: "result"; readonly id: number; readonly ok: false; readonly error: string }
  | { readonly type: "notice"; readonly level: Notice["level"]; readonly message: string };

export type ClientFrame =
  | {
      readonly type: "subscribe";
      readonly stream: StreamName;
      /**
       * `"ref"` (5.15, ADR-0027): a `conversation:` stream carries image blocks
       * as `{ type: "image", mimeType, ref }`, bytes fetched with `image`.
       * Other streams and older hosts ignore it and send bytes inline, so a
       * client reads both forms.
       */
      readonly images?: "ref";
    }
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
      // A value this host doesn't know is a newer client's form: fall back to inline.
      const refs = value.type === "subscribe" && value.images === "ref";
      return { kind: "frame", frame: refs ? { type: "subscribe", stream, images: "ref" } : { type: value.type, stream } };
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

/** Call names kept in sync with CallMethods by deriving them from the exhaustive gate table. */
const CALL_METHODS = Object.keys(CALL_SINCE) as readonly CallMethod[];

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
  const submissionId = (): boolean =>
    typeof args.submissionId === "number" && Number.isSafeInteger(args.submissionId) && args.submissionId >= 1;
  // Shape only — count, mime type, base64 and size limits are the host's check
  // (imageProblem), and so is whether a ref is one the connection was shown.
  // A ref form is just a nonempty name; the host knows the type it recorded.
  const images = (): boolean =>
    args.images === undefined
    || (Array.isArray(args.images)
      && args.images.every(
        (image) =>
          record(image)
          && ("data" in image
            ? typeof image.data === "string" && typeof image.mimeType === "string"
            : nonempty(image.ref)),
      ));
  // Shape only — whether a name is a skill in scope is the host's check (a notice).
  const skills = (): boolean => args.skills === undefined || (Array.isArray(args.skills) && args.skills.every(nonempty));
  // Shape only — count, existence and state are the host's check.
  const attachments = (): boolean =>
    args.attachments === undefined || (Array.isArray(args.attachments) && args.attachments.every(nonempty));
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
        && nonempty(args.requestId) && images() && skills() && attachments()
      );
    case "withdrawQueued":
    case "steerQueued":
      return conversationId() && submissionId();
    case "abort":
      return conversationId();
    case "setThinkingLevel":
      return conversationId() && nonempty(args.level);
    case "setAgent":
      // Shape only — whether the name resolves (or the file/model works) is
      // the host's `ok:false`, not a malformed frame.
      return conversationId() && (args.agent === null || nonempty(args.agent));
    case "compact":
      return conversationId() && (args.instructions === undefined || typeof args.instructions === "string");
    case "listCommands":
      return conversationId();
    case "runCommand":
      // Shape only — an unknown name is the host's `ok:false`, not malformed.
      return conversationId() && nonempty(args.name) && (args.args === undefined || typeof args.args === "string");
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
    case "image":
      return nonempty(args.ref) && (args.variant === undefined || args.variant === "thumbnail" || args.variant === "preview");
    case "beginAttachment":
      return nonempty(args.name) && typeof args.size === "number" && Number.isSafeInteger(args.size) && args.size >= 0;
    case "appendAttachment":
      return (
        nonempty(args.attachmentId)
        && typeof args.offset === "number" && Number.isSafeInteger(args.offset) && args.offset >= 0
        && typeof args.data === "string"
      );
    case "addProject":
    case "removeProject":
      return nonempty(args.path);
    case "listFolders":
      // Absoluteness is the host's check — the frame only needs a usable name.
      return args.path === undefined || nonempty(args.path);
    case "createConversation":
      return (
        record(args.home) && (args.home.kind === "chat" || (args.home.kind === "project" && nonempty(args.home.path)))
        && typeof args.text === "string"
        && (nonempty(args.text)
          || (Array.isArray(args.images) && args.images.length > 0)
          || (Array.isArray(args.attachments) && args.attachments.length > 0))
        && nonempty(args.requestId) && images() && skills() && attachments()
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
    case "listSkills":
      // Same rule as listFiles: the discriminant's shape is protocol, scope
      // resolution failures are `ok:false` business errors.
      return (
        record(args.scope)
        && ((args.scope.kind === "conversation"
            && typeof args.scope.conversationId === "number"
            && Number.isSafeInteger(args.scope.conversationId)
            && args.scope.conversationId >= 1)
          || (args.scope.kind === "project"
            && nonempty(args.scope.path)
            && (args.scope.checkout === "worktree" || args.scope.checkout === "project"))
          || args.scope.kind === "chat")
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
    case "removeCustomProvider":
      return nonempty(args.providerId);
    case "beginLogin":
      return nonempty(args.providerId) && (args.method === "oauth" || args.method === "api_key");
    case "answerLogin":
      return (
        nonempty(args.loginId) && typeof args.promptId === "number" && Number.isSafeInteger(args.promptId)
        && typeof args.value === "string"
      );
    case "cancelLogin":
      return nonempty(args.loginId);
    case "saveCustomProvider":
      // Shape only — id rules, URL syntax and name clashes are the host's `ok:false`.
      return (
        record(args.provider) && nonempty(args.provider.id) && typeof args.provider.name === "string"
        && isCustomProviderApi(args.provider.api) && typeof args.provider.baseUrl === "string"
        && Array.isArray(args.provider.models) && args.provider.models.every((model) => typeof model === "string")
        && (args.apiKey === undefined || args.apiKey === null || typeof args.apiKey === "string")
      );
    case "listEndpointModels":
      return (
        isCustomProviderApi(args.api) && typeof args.baseUrl === "string"
        && (args.apiKey === undefined || typeof args.apiKey === "string")
        && (args.providerId === undefined || nonempty(args.providerId))
      );
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
