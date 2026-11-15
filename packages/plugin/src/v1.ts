// Plugin API v1, server half (ADR-0049, ADR-0050). A plugin's `server.ts`
// default-exports `definePlugin(fn)`; `fn` receives a HostApi and registers its
// states, tools and methods before returning. This package only declares the
// API: the host builds `server.ts` and hands it its own `definePlugin` when the
// script runs, so a plugin bundles nothing from here.

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** A conversation's id, as the host and the plugin's UI name it. */
export type ConversationId = number;

/** A handle returned by `state()`; pass it to `read` or `tx.get`. */
export interface PluginState<T> {
  readonly name: string;
  /** Type-only marker; never set at runtime. */
  readonly __value?: T;
}

export interface StateOptions<T extends JsonObject> {
  /** Positive integer version of the stored shape. */
  readonly version: number;
  /** Offered to clients as a conversation document stream (default true); false keeps it on the host. */
  readonly shared?: boolean;
  /** The value of a conversation that has never written this state. */
  readonly initial: () => T;
}

/** A handle returned by `secret()`; pass it to `ctx.secret`. */
export interface PluginSecret {
  readonly name: string;
}

export interface SecretOptions {
  /** Tells the user what to enter, e.g. "A GitHub token with repo access". */
  readonly description: string;
}

export interface PluginTx {
  /** A draft of the state for this conversation; mutate it in place. */
  get<T>(state: PluginState<T>): Promise<T>;
}

export interface PluginContext {
  readonly conversationId: ConversationId;
  /** The conversation's working directory, inside a tool; undefined in a method or a conversation without one. */
  readonly cwd: string | undefined;
  /**
   * A secret's value as the user set it, read now; undefined while unset. The host
   * replaces every set secret of this plugin, and every value the call read, with
   * `[redacted]` in what a tool returns or throws, but a value the plugin derives (encodes, splits) is the
   * plugin's to keep out of its results.
   */
  secret(secret: PluginSecret): Promise<string | undefined>;
  /** The committed value for this conversation. */
  read<T>(state: PluginState<T>): Promise<T>;
  /** One commit: every draft `fn` mutates is stored together, or none is. */
  change(fn: (tx: PluginTx) => Promise<void>): Promise<void>;
}

export interface ToolDefinition {
  /** Unique across the host's tools: [A-Za-z0-9_], at most 64 characters, not `mcp__…`. */
  readonly name: string;
  readonly description: string;
  /** JSON Schema of the arguments; an object schema. */
  readonly parameters: JsonObject;
  /** `text` is what the model sees as the tool's result. */
  run(args: JsonObject, ctx: PluginContext): Promise<{ text: string }>;
}

/**
 * One event a source hands the host (ADR-0051 §10). The host puts it into the
 * Inbox of each project that added the source: a new task, or the task that
 * follows `thread`. Whether it counts as the user's own words is the user's
 * choice when adding the source, never the plugin's.
 */
export interface SourceEvent {
  /** Unique within this source, stable across polls (`issue:412`, `comment:98765`): a repeat is dropped. */
  readonly id: string;
  /** A short summary and pointers (a URL, a number), never the full content: the agent fetches details itself. At most 4,000 characters. */
  readonly summary: string;
  /** Routes it to the task that follows this thread, such as `github:acme/web#412`. */
  readonly thread?: string;
  /** A new task's title; defaults to the summary's first line. */
  readonly title?: string;
}

export interface SourceContext {
  /** The user's filter for this source, as they typed it; `""` when the source takes none. */
  readonly filter: string;
  /** A secret's value as the user set it, read now; undefined while unset. Secrets are scrubbed from event summaries. */
  secret(secret: PluginSecret): Promise<string | undefined>;
}

export interface PollResult {
  /** New events, oldest first. */
  readonly events: readonly SourceEvent[];
  /** Kept by the host and passed to the next poll; stored with the events, so a crash repeats a poll, never skips one. */
  readonly cursor?: JsonValue;
}

export interface SourceDefinition {
  /** Unique in the plugin: [A-Za-z0-9_-]. */
  readonly name: string;
  /** The kind of event, shown when the user adds a source: "New issues". */
  readonly description: string;
  /** What the user's filter means, such as "owner/repo, then label:bug"; leave it out when the source takes none. */
  readonly filter?: string;
  /**
   * Its events only reach a task that already follows their thread (one the
   * agent registered with `inbox_follow`, such as a PR it opened); the rest are
   * dropped. Use it for comments and CI results, which should not each open a task.
   */
  readonly followedOnly?: boolean;
  /**
   * Polled: the host calls `run` for each added source when it is enabled or
   * the host starts, then every `intervalMs` (default five minutes, from a
   * minute to a day). `cursor` is what the last poll returned, undefined the first
   * time; a first poll should usually return only a cursor, not the backlog.
   * A throw is shown on the source and the next poll tries again.
   */
  readonly poll?: {
    readonly intervalMs?: number;
    run(input: { readonly cursor: JsonValue | undefined }, ctx: SourceContext): Promise<PollResult>;
  };
  /**
   * Pushed: called for each added source while it is enabled; call `emit` as
   * events arrive, and return a function that stops listening. Called again
   * after the plugin reloads or the host restarts.
   */
  readonly listen?: (emit: (event: SourceEvent) => Promise<void>, ctx: SourceContext) => (() => void) | Promise<() => void>;
}

export interface HostApi {
  /** Per-conversation JSON state. */
  state<T extends JsonObject>(name: string, options: StateOptions<T>): PluginState<T>;
  /**
   * A credential the user enters in a client, stored by the host outside the
   * agent's reach (ADR-0052 §6). Clients can set it and see whether it is set,
   * never read it back. Name: [A-Za-z0-9_-].
   */
  secret(name: string, options: SecretOptions): PluginSecret;
  /** A tool the model can call. */
  tool(definition: ToolDefinition): void;
  /** An Inbox event source the user can add to a project (ADR-0051 §10): give exactly one of `poll` and `listen`. */
  source(definition: SourceDefinition): void;
  /** Callable from the plugin's UI through the `pluginCall` wire call. */
  method(name: string, run: (args: JsonValue, ctx: PluginContext) => Promise<JsonValue>): void;
}

/** The function a plugin passes to `definePlugin`; it registers everything before it returns. */
export type HostPlugin = (pinomad: HostApi) => void;

/** What `definePlugin` returns; opaque to the plugin. */
export interface ServerPlugin {
  readonly setup: unknown;
}

/** The default export of a plugin's `server.ts`. Provided by the host at runtime. */
export declare function definePlugin(plugin: HostPlugin): ServerPlugin;
