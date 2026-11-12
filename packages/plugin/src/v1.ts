// Plugin API v1, host half (ADR-0049). A plugin's `host.ts` default-exports a
// function that receives a HostApi and registers its states, tools and
// methods before returning. Import these with `import type` only: the host
// runs `host.ts` with Node's type stripping, and there is nothing to import
// at runtime.

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

export interface PluginTx {
  /** A draft of the state for this conversation; mutate it in place. */
  get<T>(state: PluginState<T>): Promise<T>;
}

export interface PluginContext {
  readonly conversationId: ConversationId;
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
  /** A tool the model can call. */
  tool(definition: ToolDefinition): void;
  /** Callable from the plugin's UI through the `pluginCall` wire call. */
  method(name: string, run: (args: JsonValue, ctx: PluginContext) => Promise<JsonValue>): void;
}

/** The default export of a plugin's `host.ts`. */
export type HostPlugin = (pinomad: HostApi) => void;
