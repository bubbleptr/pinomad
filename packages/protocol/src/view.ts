// The client contract, after DurableView / DurableViewSource / DurableController in
// pi's packages/coding-agent/src/experimental/durable/runtime.ts (MIT, Earendil Works).
// `connection` is the one addition, since a remote view can lose its host.
import type { ConversationId, ConversationView, JsonObject, ModelRef, TaskGraph } from "@earendil-works/pi-durable";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { DeviceEntry } from "./devices.ts";
import type { McpStatus } from "./mcp.ts";
import type { Home, Organized, WorktreeCheckout } from "./organization.ts";
import type { PresentationType, QuestionAnswer } from "./presentation.ts";

/** A model's thinking level, "off" included. pi-ai's `ModelThinkingLevel`, re-exported for browser clients. */
export type ThinkingLevel = ModelThinkingLevel;

export interface ModelSummary extends ModelRef {
  readonly name: string;
  readonly contextWindow: number;
  /** Levels the model supports, always starting with "off"; a non-reasoning model reports ["off"]. */
  readonly thinkingLevels: readonly ThinkingLevel[];
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
  /** The first user message, for a subagent its task. */
  readonly title?: string;
}

export interface SessionInfo {
  readonly id: string;
  readonly directory: string;
}

/** `outdated`: the host's hello announced a newer protocol; terminal like `closed`, no reconnect. */
export type ConnectionState = "connected" | "reconnecting" | "closed" | "outdated";

/** One extension document of the shown conversation, as the host declared it. */
export interface ExtensionDocView {
  readonly kind: string;
  /** The host's rendering hint; absent means fallback rendering. */
  readonly presentation?: PresentationType;
  /** `null` while the document does not exist for this conversation. */
  readonly value: JsonObject | null;
}

/** Everything a client renders. Plain values; no Harness objects cross this boundary. */
export interface DurableView {
  readonly session: SessionInfo;
  /** The conversation shown and talked to; undefined until one is shown. */
  readonly conversation?: ConversationView;
  /** Chats and projects with their conversations, grouped for navigation. */
  readonly organized: Organized;
  /** The shown conversation's home, inherited from its index ancestor. */
  readonly home?: Home;
  /** The shown conversation's worktree checkout (ADR-0010); absent for project-dir and Chat checkouts. */
  readonly checkout?: WorktreeCheckout;
  readonly models: readonly ModelSummary[];
  /** The host's new-conversation defaults, from the hello frame. */
  readonly defaults: ConversationDefaults;
  readonly notices: readonly Notice[];
  /** The live task graph while the task panel is open. */
  readonly tasks?: TaskGraph;
  readonly connection: ConnectionState;
  /** The shown conversation's extension documents, in the host's order. */
  readonly docs: readonly ExtensionDocView[];
  /** How the host wants each tool's result `details` rendered (ADR-0005). */
  readonly toolPresentations: Record<string, PresentationType>;
  /** Paired devices on the host (ADR-0008); empty while remote access is off. */
  readonly devices: readonly DeviceEntry[];
  /** MCP server status (ADR-0012); `null` while the snapshot has not arrived. */
  readonly mcp: McpStatus | null;
}

export interface DurableViewSource {
  current(): DurableView;
  subscribe(listener: () => void): () => void;
}

/** What a client may ask for. */
export interface DurableController {
  /** Register a local directory as a project; returns the stored (normalized) project. */
  addProject(path: string): Promise<void>;
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
    options?: { checkout?: "worktree" | "project"; model?: ModelRef; thinkingLevel?: ThinkingLevel },
  ): Promise<void>;
  /** Hide or restore a top-level conversation in the index. */
  archive(id: ConversationId, archived: boolean): Promise<void>;
  /** Prompt when idle; otherwise steer or queue a follow-up. */
  submit(text: string, whenBusy: "steer" | "followUp"): Promise<void>;
  compact(instructions: string | undefined): Promise<void>;
  abort(): Promise<void>;
  /** Set the shown conversation's thinking level; rejects when the model can't take it. */
  setThinkingLevel(level: ThinkingLevel): Promise<void>;
  setModel(model: ModelRef): Promise<void>;
  toggleTasks(): Promise<void>;
  /** Show and talk to another conversation. */
  switchConversation(id: ConversationId): Promise<void>;
  /** Fork the shown conversation at an entry, switch to the fork, and send it `prompt`. */
  fork(entryId: string, prompt: string, removeTools?: readonly string[]): Promise<void>;
  /** Answer a pending `pinomad.question` request; failures surface as notices. */
  answer(kind: string, requestId: string, answers: QuestionAnswer[]): Promise<void>;
  /** The shown conversation's file changes; unavailable for Chat and non-git checkouts. */
  changes(): Promise<{ available: false; reason: string } | { available: true; base: string; patch: string; truncated: boolean }>;
  /** A one-time pairing offer for a new device; rejects while remote access is off. */
  createPairing(): Promise<{ url: string; expiresAt: number }>;
  /** Forget a paired device and drop its live connections. */
  revokeDevice(publicKey: string): Promise<void>;
}
