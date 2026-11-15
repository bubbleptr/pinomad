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
