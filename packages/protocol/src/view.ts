// The client contract, after DurableView / DurableViewSource / DurableController in
// pi's packages/coding-agent/src/experimental/durable/runtime.ts (MIT, Earendil Works).
// `connection` is the one addition, since a remote view can lose its host.
// See docs/licenses/pi.md for the upstream notice.
import type { ConversationId, ConversationView, JsonObject, ModelRef, TaskGraph } from "@earendil-works/pi-durable";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { AgentRole, AgentRoles } from "./agents.ts";
import type { HostAuth } from "./auth.ts";
import type { DeviceEntry } from "./devices.ts";
import type { ProtocolVersion } from "./frames.ts";
import type { McpStatus } from "./mcp.ts";
import type { FolderListing, Home, Organized, Project, WorktreeCheckout } from "./organization.ts";
import type { PresentationType, QuestionAnswer } from "./presentation.ts";
import type { HostSettings, HostSettingsPatch } from "./settings.ts";
import type { MessageImage } from "./images.ts";

/** A model's thinking level, "off" included. pi-ai's `ModelThinkingLevel`, re-exported for browser clients. */
export type ThinkingLevel = ModelThinkingLevel;

export interface ModelSummary extends ModelRef {
  readonly name: string;
  readonly contextWindow: number;
  /** Levels the model supports, always starting with "off"; a non-reasoning model reports ["off"]. */
  readonly thinkingLevels: readonly ThinkingLevel[];
  /** Whether the model accepts image input (pi-ai `input` includes "image"); absent from pre-5.5 hosts. */
  readonly images?: boolean;
}

/** What a new conversation starts with; the host's configured defaults. */
export interface ConversationDefaults {
  readonly model?: ModelRef;
  readonly thinkingLevel?: ThinkingLevel;
}

export interface Notice {
  readonly id: number;
  readonly level: "info" | "warning" | "error";
  readonly message: string;
}

/** A stored conversation; `parent` nests it under the conversation it forked or the one owning its task. */
export interface ConversationSummary {
  readonly id: ConversationId;
  readonly kind: "conversation" | "fork" | "subagent";
  /** Fork source conversation, or the conversation owning the subagent's task. */
  readonly parent?: ConversationId;
  /** Forks only: the parent entry the fork inherits through. */
  readonly forkedAt?: string;
  /** The generated or manual name when set, else the first user message; for a subagent its task. */
  readonly title?: string;
  /** Absent means idle. Precedence: needs-answer (a pinomad.question request is unresolved) > running (a run is in flight) > failed (the newest run ended in an error). */
  readonly status?: "needs-answer" | "running" | "failed";
  /** Epoch ms of the conversation's newest own user/assistant message; absent before its first. */
  readonly updatedAt?: number;
  /** Subagents only: the `description` the delegating agent gave the call. */
  readonly label?: string;
  /** Subagents only: the named agent it ran as (ADR-0023). */
  readonly role?: string;
  /** Running only: the tool call in flight, e.g. { tool: "read", target: "src/a.ts" }; absent while thinking/writing or idle. */
  readonly activity?: { readonly tool: string; readonly target?: string };
}

export interface SessionInfo {
  readonly id: string;
  readonly directory: string;
}

/** `outdated`: the host's hello announced a different protocol major; terminal like `closed`, no reconnect. */
export type ConnectionState = "connected" | "reconnecting" | "closed" | "outdated";

/** The version split behind an `outdated` connection, for the UI's upgrade hint. */
export interface ProtocolMismatch {
  readonly hostMajor: number;
  readonly clientMajor: number;
  /** Packaged release version; absent for a source checkout. */
  readonly hostVersion?: string;
  /** Which side is behind: `client-older` → update the app; `host-older` → upgrade the host. */
  readonly direction: "client-older" | "host-older";
}

/** One extension document of the shown conversation, as the host declared it. */
export interface ExtensionDocView {
  readonly kind: string;
  /** The host's rendering hint; absent means fallback rendering. */
  readonly presentation?: PresentationType;
  /** `null` while the document does not exist for this conversation. */
  readonly value: JsonObject | null;
}

/** A second conversation shown beside the main one, with its documents. */
export interface SideConversationView {
  readonly id: ConversationId;
  /** Undefined until its snapshot arrives, or after the host ended its stream. */
  readonly conversation?: ConversationView;
  /** Its extension documents, in the host's order; a doc joins once its snapshot arrived. */
  readonly docs: readonly ExtensionDocView[];
}

/** Everything a client renders. Plain values; no Harness objects cross this boundary. */
export interface DurableView {
  readonly session: SessionInfo;
  /** The conversation shown and talked to; undefined until one is shown. */
  readonly conversation?: ConversationView;
  /** The side conversation, while one is shown. */
  readonly side?: SideConversationView;
  /** Chats and projects with their conversations, grouped for navigation. */
  readonly organized: Organized;
  /** The shown conversation's home, inherited from its index ancestor. */
  readonly home?: Home;
  /** The shown conversation's worktree checkout (ADR-0010); absent for project-dir and Chat checkouts. */
  readonly checkout?: WorktreeCheckout;
  /** The host's available models: the `models` stream once its snapshot arrived, else the hello's list (5.0 hosts). */
  readonly models: readonly ModelSummary[];
  /** The host's new-conversation defaults: derived from the `settings` stream when present, else the hello frame (pre-5.2 hosts). */
  readonly defaults: ConversationDefaults;
  readonly notices: readonly Notice[];
  /** The live task graph while the task panel is open. */
  readonly tasks?: TaskGraph;
  readonly connection: ConnectionState;
  /** The mismatch a post-ready hello announced; set exactly when `connection` is `"outdated"`. */
  readonly protocolMismatch?: ProtocolMismatch;
  /** Set when the host closed this device with 4401 (pairing failed or revoked); terminal. */
  readonly unauthorized?: true;
  /** The shown conversation's extension documents, in the host's order. */
  readonly docs: readonly ExtensionDocView[];
  /** How the host wants each tool's result `details` rendered (ADR-0005). */
  readonly toolPresentations: Record<string, PresentationType>;
  /** Paired devices on the host (ADR-0008); empty while remote access is off. */
  readonly devices: readonly DeviceEntry[];
  /** MCP server status (ADR-0012); `null` while the snapshot has not arrived. */
  readonly mcp: McpStatus | null;
  /** Stored-credential logins on the host; `null` before its snapshot or when the host predates the `auth` stream (5.1). */
  readonly auth: HostAuth | null;
  /** Effective host settings (ADR-0021); `null` before its snapshot or when the host predates the `settings` stream (5.2). */
  readonly settings: HostSettings | null;
  /** Named agents on the host (ADR-0023); `null` before its snapshot or when the host predates the `agents` stream (5.6). */
  readonly agents: AgentRoles | null;
  /** What the host announced in its hello; `version` is absent when the host runs from a source checkout. */
  readonly host?: { readonly version?: string; readonly protocol: ProtocolVersion };
}

export interface DurableViewSource {
  current(): DurableView;
  subscribe(listener: () => void): () => void;
}

/** What a client may ask for. */
export interface DurableController {
  /**
   * Register a local directory as a project; resolves with the stored
   * (normalized) project. Rejects with the host's error — the caller shows it
   * (no notice).
   */
  addProject(path: string): Promise<Project>;
  /** One page of the folder picker: a host directory and its visible subfolders. Rejects on error (the caller shows it). Needs a 5.3 host. */
  listFolders(path?: string): Promise<FolderListing>;
  /** Unregister a project; its directory and conversations are kept. */
  removeProject(path: string): Promise<void>;
  /**
   * Create a conversation at a home, send `text`, and show it. `checkout` selects
   * project-dir over the worktree default; `model`/`thinkingLevel` override the
   * host's defaults for the new agent (the level clamps to the model's levels).
   */
  createConversation(
    home: Home,
    text: string,
    options?: {
      checkout?: "worktree" | "project";
      model?: ModelRef;
      thinkingLevel?: ThinkingLevel;
      /** Up to 4 attached images; needs a 5.5 host. */
      images?: readonly MessageImage[];
    },
  ): Promise<void>;
  /** Hide or restore a top-level conversation in the index. */
  archive(id: ConversationId, archived: boolean): Promise<void>;
  /** Rename a conversation permanently; rejects with the host's error (the caller shows it). Needs a 5.4 host. */
  renameConversation(id: ConversationId, title: string): Promise<void>;
  /**
   * Prompt when idle; otherwise steer or queue a follow-up. `target` defaults
   * to the main shown conversation. `requestId` is an idempotency key: the
   * host admits one submission per key and conversation; defaults to a fresh
   * one. `images` attaches up to 4 images; needs a 5.5 host.
   */
  submit(
    text: string,
    whenBusy: "steer" | "followUp",
    options?: { target?: ConversationId; requestId?: string; images?: readonly MessageImage[] },
  ): Promise<void>;
  compact(instructions: string | undefined): Promise<void>;
  /** Abort `target`'s run (the main shown conversation's by default). */
  abort(target?: ConversationId): Promise<void>;
  /** Set the shown conversation's thinking level; rejects when the model can't take it. */
  setThinkingLevel(level: ThinkingLevel): Promise<void>;
  setModel(model: ModelRef): Promise<void>;
  toggleTasks(): Promise<void>;
  /** Show and talk to another conversation. */
  switchConversation(id: ConversationId): Promise<void>;
  /** Show a conversation beside the main one, or close the side with `undefined`; resolves once its snapshots arrived. */
  showSide(id: ConversationId | undefined): Promise<void>;
  /** Fork the shown conversation at an entry and send it `prompt`. `show` picks where it opens: the main slot (default) or the side panel. */
  fork(entryId: string, prompt: string, removeTools?: readonly string[], options?: { show?: "main" | "side" }): Promise<void>;
  /** Answer a pending `pinomad.question` request on `target` (the main shown conversation by default); failures surface as notices. */
  answer(kind: string, requestId: string, answers: QuestionAnswer[], target?: ConversationId): Promise<void>;
  /** The shown conversation's file changes; unavailable for Chat and non-git checkouts. */
  changes(): Promise<{ available: false; reason: string } | { available: true; base: string; patch: string; truncated: boolean }>;
  /** A one-time pairing offer for a new device; rejects while remote access is off. */
  createPairing(): Promise<{ url: string; expiresAt: number }>;
  /** Forget a paired device and drop its live connections. */
  revokeDevice(publicKey: string): Promise<void>;
  /** Remove a provider's stored credential on the host; this also logs the Pi CLI on that machine out (ADR-0021 §5). Needs a 5.1 host. */
  logout(providerId: string): Promise<void>;
  /** Patch the host's settings; each `null` resets that key to the pi/built-in fallback. Needs a 5.2 host. */
  updateSettings(patch: HostSettingsPatch): Promise<void>;
  /** Create a named agent on the host; rejects when `<name>.md` already exists. Needs a 5.6 host. */
  createAgent(role: AgentRole): Promise<void>;
  /** Overwrite an existing named agent — also the way a broken file gets fixed. Renaming is create + delete. Needs a 5.6 host. */
  updateAgent(role: AgentRole): Promise<void>;
  /** Delete a named agent's file; rejects when it does not exist. Needs a 5.6 host. */
  deleteAgent(name: string): Promise<void>;
  /**
   * Register this device's Expo push token on the host (`null` clears it).
   * Secure-channel (paired device) clients only; rejects with the host's error —
   * the caller shows it (no notice). Needs a 5.7 host.
   */
  setPushToken(token: string | null): Promise<void>;
}
