// Plugin loader (ADR-0049). Each `<dataDir>/plugins/<name>/` is read once at
// startup and becomes a Durable extension `plugin.<name>`, built the same way
// as a built-in one. A plugin that fails to validate or load is skipped with
// one log line; the host and the other plugins carry on.
import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { Context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import {
  defineDoc,
  defineExtension,
  defineTool,
  type ConversationDocToken,
  type ConversationId,
  type DocumentReader,
  type JsonObject,
  type ToolRegistration,
  type Tx,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import type { PluginInfo } from "@pinomad/protocol/frames.ts";
import type { HostApi, HostPlugin, PluginContext, PluginState, StateOptions, ToolDefinition } from "@pinomad/plugin/v1";
import type { BuiltinExtension, ExtensionDoc } from "./builtin-extension.ts";

const NAME = /^[a-z][a-z0-9-]*$/;
const STATE_NAME = /^[A-Za-z0-9_-]+$/;
/** Provider-safe tool names; `mcp__…` is the MCP bridge's namespace. */
const TOOL_NAME = /^[A-Za-z0-9_]{1,64}$/;

/** Where plugin state is read and committed: the Harness for methods, the tool API inside a tool. */
export interface PluginStore {
  readonly snapshot: DocumentReader["snapshot"];
  commit<T>(change: (tx: Tx) => Promise<T>, context: Context): Promise<T>;
}

export type PluginMethod = (args: JsonValue, store: PluginStore, conversationId: ConversationId, context: Context) => Promise<JsonValue>;

export interface Plugins {
  /** Durable extensions to install, one per loaded plugin. */
  readonly extensions: readonly BuiltinExtension[];
  /** `hello.plugins`, in load order. */
  readonly info: readonly PluginInfo[];
  /** The plugin's `web.js` text; throws for an unknown plugin or one without a web half. */
  bundle(name: string): string;
  /** Throws for an unknown plugin or method. */
  method(plugin: string, method: string): PluginMethod;
}

interface Loaded {
  readonly info: PluginInfo;
  readonly extension: BuiltinExtension;
  readonly code?: string;
  readonly methods: ReadonlyMap<string, PluginMethod>;
}

/**
 * Load every plugin under `dir`, in name order. `reservedTools` are the tool
 * names already taken (built-in extensions); a plugin whose tool collides
 * with one of them or with an earlier plugin's is skipped.
 */
export async function loadPlugins(
  dir: string,
  options: { readonly reservedTools: Iterable<string>; readonly log?: (line: string) => void },
): Promise<Plugins> {
  const log = options.log ?? ((line) => console.error(line));
  const taken = new Set(options.reservedTools);
  const loaded = new Map<string, Loaded>();
  let entries: string[];
  try {
    // stat, not the dirent: a symlinked plugin directory (a checkout elsewhere) loads too.
    const names = (await readdir(dir)).sort();
    const isDir = await Promise.all(names.map((name) => stat(join(dir, name)).then((info) => info.isDirectory(), () => false)));
    entries = names.filter((_, index) => isDir[index]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") log(`plugins: cannot read ${dir}: ${message(error)}`);
    entries = [];
  }
  for (const name of entries) {
    try {
      const plugin = await loadPlugin(join(dir, name), name, taken);
      for (const tool of plugin.extension.extension.tools ?? []) taken.add(tool.name);
      loaded.set(name, plugin);
    } catch (error) {
      log(`plugin ${name}: skipped: ${message(error)}`);
    }
  }
  const find = (name: string): Loaded => {
    const plugin = loaded.get(name);
    if (plugin === undefined) throw new Error(`Unknown plugin ${name}`);
    return plugin;
  };
  return {
    extensions: [...loaded.values()].map((plugin) => plugin.extension),
    info: [...loaded.values()].map((plugin) => plugin.info),
    bundle: (name) => {
      const { code } = find(name);
      if (code === undefined) throw new Error(`Plugin ${name} has no web bundle`);
      return code;
    },
    method: (plugin, method) => {
      const run = find(plugin).methods.get(method);
      if (run === undefined) throw new Error(`Unknown method ${method} on plugin ${plugin}`);
      return run;
    },
  };
}

async function loadPlugin(root: string, dirName: string, taken: ReadonlySet<string>): Promise<Loaded> {
  const manifest = JSON.parse(await readFile(join(root, "plugin.json"), "utf8")) as Record<string, unknown>;
  if (!NAME.test(dirName)) throw new Error(`directory name must match ${NAME}`);
  if (manifest.name !== dirName) throw new Error(`plugin.json name ${JSON.stringify(manifest.name)} does not match the directory`);
  if (manifest.api !== 1) throw new Error(`unsupported api ${JSON.stringify(manifest.api)}`);
  const hostFile = manifest.host === undefined ? undefined : await inside(root, manifest.host, "host");
  const webFile = manifest.web === undefined ? undefined : await inside(root, manifest.web, "web");

  let web: { code: string; hash: string; size: number } | undefined;
  if (webFile !== undefined) {
    const bytes = await readFile(webFile);
    const code = bytes.toString("utf8");
    // Clients receive the text and check it against the digest, so the two must agree.
    if (!Buffer.from(code, "utf8").equals(bytes)) throw new Error("web bundle is not valid UTF-8");
    web = { code, size: bytes.length, hash: createHash("sha256").update(bytes).digest("hex") };
  }

  const registered = hostFile === undefined ? emptyRegistration() : await register(hostFile, dirName);
  for (const tool of registered.tools) {
    if (!TOOL_NAME.test(tool.name)) throw new Error(`tool name ${JSON.stringify(tool.name)} must match ${TOOL_NAME}`);
    if (tool.name.startsWith("mcp__")) throw new Error(`tool name ${tool.name} is reserved for MCP`);
    if (taken.has(tool.name)) throw new Error(`tool ${tool.name} is already defined`);
  }

  const tokens = new Map<PluginState<unknown>, ConversationDocToken<JsonObject>>();
  const docs: ExtensionDoc[] = [];
  for (const { handle, options } of registered.states) {
    const token = defineDoc<JsonObject>({
      kind: `plugin.${dirName}.${handle.name}`,
      version: options.version,
      scope: "conversation",
      history: "rewindable",
      fork: "asOf",
      initial: options.initial,
      checkpointWhen: () => false,
    });
    tokens.set(handle, token);
    if (options.shared !== false) docs.push({ token });
  }
  const tokenOf = (state: PluginState<unknown>): ConversationDocToken<JsonObject> => {
    const token = tokens.get(state);
    if (token === undefined) throw new Error(`State ${state.name} does not belong to plugin ${dirName}`);
    return token;
  };
  const contextFor = (store: PluginStore, conversationId: ConversationId, context: Context): PluginContext => ({
    conversationId,
    read: async <T>(state: PluginState<T>): Promise<T> => {
      const token = tokenOf(state);
      return ((await store.snapshot(token, conversationId, context)) ?? token.definition.initial()) as T;
    },
    change: async (fn) => {
      await store.commit(async (tx) => {
        await fn({ get: async <T>(state: PluginState<T>): Promise<T> => (await tx.doc(tokenOf(state), conversationId)) as T });
      }, context);
    },
  });

  const tools: ToolRegistration[] = registered.tools.map((tool) =>
    defineTool({
      name: tool.name,
      description: tool.description,
      // Providers require an object schema, as for MCP tools.
      parameters: Type.Unsafe<JsonObject>({ ...tool.parameters, type: "object", properties: tool.parameters.properties ?? {} }),
      // The plugin's run may have side effects outside its state; an interrupted call is not rerun.
      replay: "unsafe",
      execute: async (args, api, context) => {
        try {
          const { text } = await tool.run(args as JsonObject, contextFor(api, api.conversationId, context));
          return { output: [{ type: "text", text }] };
        } catch (error) {
          if (context.abortSignal?.aborted === true) throw error;
          return { output: [{ type: "text", text: message(error) }], isError: true };
        }
      },
    }),
  );
  const methods = new Map<string, PluginMethod>(
    [...registered.methods].map(([name, run]) => [
      name,
      (args, store, conversationId, context) => run(args, contextFor(store, conversationId, context)),
    ]),
  );

  return {
    info: { name: dirName, api: 1, ...(web === undefined ? {} : { web: { hash: web.hash, size: web.size } }) },
    extension: { extension: defineExtension({ name: `plugin.${dirName}`, tools }), docs },
    ...(web === undefined ? {} : { code: web.code }),
    methods,
  };
}

interface Registration {
  readonly states: { readonly handle: PluginState<unknown>; readonly options: StateOptions<JsonObject> }[];
  readonly tools: ToolDefinition[];
  readonly methods: Map<string, (args: JsonValue, ctx: PluginContext) => Promise<JsonValue>>;
}

const emptyRegistration = (): Registration => ({ states: [], tools: [], methods: new Map() });

/** Run the plugin's default export and collect what it registers; registering afterwards throws. */
async function register(file: string, plugin: string): Promise<Registration> {
  const module = (await import(pathToFileURL(file).href)) as { default?: unknown };
  if (typeof module.default !== "function") throw new Error("host file has no default export function");
  const registration = emptyRegistration();
  let open = true;
  const guard = (what: string) => {
    if (!open) throw new Error(`plugin ${plugin}: ${what} must be called while the plugin loads`);
  };
  const api: HostApi = {
    state: <T extends JsonObject>(name: string, options: StateOptions<T>): PluginState<T> => {
      guard("state");
      if (typeof name !== "string" || !STATE_NAME.test(name)) throw new Error(`state name ${JSON.stringify(name)} must match ${STATE_NAME}`);
      if (registration.states.some((state) => state.handle.name === name)) throw new Error(`state ${name} is defined twice`);
      if (!Number.isInteger(options?.version) || options.version < 1) throw new Error(`state ${name} needs a positive integer version`);
      if (typeof options.initial !== "function") throw new Error(`state ${name} needs an initial function`);
      const handle: PluginState<T> = Object.freeze({ name });
      registration.states.push({ handle, options: options as StateOptions<JsonObject> });
      return handle;
    },
    tool: (definition) => {
      guard("tool");
      const { name, description, parameters, run } = (definition ?? {}) as Partial<ToolDefinition>;
      if (typeof name !== "string" || typeof description !== "string" || typeof run !== "function" || !isPlainObject(parameters)) {
        throw new Error(`tool ${JSON.stringify(name)} needs a string name and description, an object parameters schema and a run function`);
      }
      if (registration.tools.some((tool) => tool.name === definition.name)) throw new Error(`tool ${definition.name} is defined twice`);
      registration.tools.push(definition);
    },
    method: (name, run) => {
      guard("method");
      if (typeof name !== "string" || typeof run !== "function") throw new Error("method needs a string name and a run function");
      if (registration.methods.has(name)) throw new Error(`method ${name} is defined twice`);
      registration.methods.set(name, run);
    },
  };
  try {
    await (module.default as HostPlugin)(api);
  } finally {
    open = false;
  }
  return registration;
}

/** Resolve a manifest path and require it to stay inside the plugin directory, symlinks included. */
async function inside(root: string, value: unknown, field: string): Promise<string> {
  if (typeof value !== "string" || value === "") throw new Error(`${field} must be a file name`);
  const base = await realpath(root);
  const target = await realpath(join(root, value));
  if (!target.startsWith(base + sep)) throw new Error(`${field} ${JSON.stringify(value)} is outside the plugin directory`);
  return target;
}

const isPlainObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
