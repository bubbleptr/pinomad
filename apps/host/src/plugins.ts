// Plugin loader (ADR-0049, ADR-0050). Every directory under `<dataDir>/plugins/`
// with a package.json is a chord plugin: chord's plugins component builds its
// `server.ts` and `web.tsx` with esbuild and watches their files, and a chord
// host embedded here loads the server halves. Each one becomes a Durable
// extension `plugin.<name>`, mirrored into the host's registry; the browser
// halves are served through `pluginBundle`. An edit is rebuilt and reloaded; a
// plugin whose build, evaluation or checks fail keeps the version it had.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { createHost, defineFacet, defineRegistry, type HostError } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import { createPlugins, type BuiltFacet, type PluginsError, type RolloutStep } from "@earendil-works/chord/plugins";
import {
  createRegistry,
  defineDoc,
  defineExtension,
  defineTool,
  registryReader,
  type ConversationDocToken,
  type ConversationId,
  type DocumentReader,
  type Extension,
  type JsonObject,
  type Registry,
  type RegistrySnapshot,
  type Tx,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import type { PluginInfo } from "@pinomad/protocol/frames.ts";
import type { HostApi, HostPlugin, PluginContext, PluginState, StateOptions, ToolDefinition } from "@pinomad/plugin/v1";
import type { ExtensionDoc } from "./builtin-extension.ts";

const context = BACKGROUND_CONTEXT;
const NAME = /^[a-z][a-z0-9-]*$/;
const STATE_NAME = /^[A-Za-z0-9_-]+$/;
/** Provider-safe tool names; `mcp__…` is the MCP bridge's namespace, so MCP tools never collide with a plugin's. */
const TOOL_NAME = /^[A-Za-z0-9_]{1,64}$/;
/** The app's own facet in chord's terms; it serves the registry the plugins contribute to. */
const CORE = "@pinomad/core";
const API = { name: "@pinomad/plugin", versions: ["v1"] };
const KINDS = {
  server: { platform: "node", hostPackages: ["@pinomad/plugin/v1"] },
  // JSX compiles to `react/jsx-runtime`, and to `react`'s createElement for a key after a spread; the
  // module wrapper answers both with the shell's React, so a plugin never bundles a second copy.
  web: { platform: "browser", hostPackages: ["@pinomad/plugin/v1", "@pinomad/plugin/v1/web", "react", "react/jsx-runtime"] },
} as const;
/** Superseded bundles kept for connections that were told about them. */
const RETAINED_BUNDLES = 32;

type Principal = { readonly kind: "host" };

/** Where plugin state is read and committed: the Harness for methods, the tool API inside a tool. */
export interface PluginStore {
  readonly snapshot: DocumentReader["snapshot"];
  commit<T>(change: (tx: Tx) => Promise<T>, context: Context): Promise<T>;
}

export type PluginMethod = (args: JsonValue, store: PluginStore, conversationId: ConversationId, context: Context) => Promise<JsonValue>;

/** What one reload changed, by plugin name; `failed` kept their loaded version (or were left out). */
export interface PluginReload {
  readonly added: readonly string[];
  readonly changed: readonly string[];
  readonly removed: readonly string[];
  readonly failed: readonly { readonly plugin: string; readonly error: string }[];
}

/** What the gateway reads; every member reflects the plugins loaded now. */
export interface PluginCatalog {
  /** `hello.plugins`, by name. */
  readonly info: readonly PluginInfo[];
  /** The loaded plugins' shared states, offered as `doc:` streams. */
  readonly docs: readonly ExtensionDoc[];
  /** The bundle a connection was told about with `hash`; throws once it is no longer kept. */
  bundle(name: string, hash: string): string;
  /** Throws for an unknown plugin or method. */
  method(plugin: string, method: string): PluginMethod;
  /** `listener` runs after each reload that added, changed or removed a plugin; returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
}

export interface Plugins extends PluginCatalog {
  close(): Promise<void>;
}

export interface PluginsOptions {
  /** Tool names a plugin may not take: the built-in extensions'. */
  readonly reservedTools: Iterable<string>;
  /** The host's registry; each loaded plugin's extension is kept installed in it. */
  readonly registry: Registry;
  readonly log?: (line: string) => void;
  /** Called after every reload that added, changed, removed or failed a plugin. */
  readonly onReload?: (outcome: PluginReload) => void;
  /** How long a burst of file events settles before a rebuild. */
  readonly debounceMs?: number;
}

interface Registration {
  readonly states: { readonly handle: PluginState<unknown>; readonly options: StateOptions<JsonObject> }[];
  readonly tools: ToolDefinition[];
  readonly methods: Map<string, (args: JsonValue, ctx: PluginContext) => Promise<JsonValue>>;
}

interface Translated {
  readonly extension: Extension;
  readonly docs: readonly ExtensionDoc[];
  readonly methods: ReadonlyMap<string, PluginMethod>;
}

/** The composed registry: the Durable snapshot the host mirrors, and each accepted plugin. */
type Composition = RegistrySnapshot & { readonly plugins: ReadonlyMap<string, Translated> };

interface WebBundle {
  readonly code: string;
  readonly hash: string;
  readonly size: number;
}

const PluginExtensions = defineRegistry<Registration, Composition>("pinomad.plugins", { version: 1 });

export async function openPlugins(dir: string, options: PluginsOptions): Promise<Plugins> {
  const log = options.log ?? ((line) => console.error(line));
  const reserved = new Set(options.reservedTools);
  // chord watches the root from the start; one created later would never be seen.
  await mkdir(dir, { recursive: true });

  const host = createHost<Principal>({ principal: { kind: "host" }, onError: (error) => log(`plugins: ${describe(error)}`) });
  const component = createPlugins(
    { roots: [dir], api: API, kinds: KINDS, onError: (error) => log(`plugins: ${describe(error)}`) },
    context,
  );
  const definePlugin = (plugin: unknown) => {
    const registration = collect(plugin, reserved);
    return defineFacet<Principal>((_host, self) => self.contribute(PluginExtensions, registration));
  };
  const core = defineFacet<Principal>((facetHost) => facetHost.serve(PluginExtensions, { compose }));

  const web = new Map<string, WebBundle>();
  const listeners = new Set<() => void>();
  const retained = new Map<string, string>();
  /** Each plugin's last failed build signature: the same files failing again are neither rolled out nor logged. */
  const failedAs = new Map<string, string>();
  const problemsLogged = new Set<string>();
  let webFailures: { plugin: string; error: string }[] = [];

  const keepWeb = (name: string, bundle: WebBundle): void => {
    web.set(name, bundle);
    retained.delete(bundle.hash);
    retained.set(bundle.hash, bundle.code);
    const current = new Set([...web.values()].map((each) => each.hash));
    for (const hash of retained.keys()) {
      if (retained.size <= RETAINED_BUNDLES) break;
      if (!current.has(hash)) retained.delete(hash);
    }
  };
  const shipWeb = (facet: BuiltFacet): void => {
    try {
      keepWeb(facet.plugin, webBundle(facet));
    } catch (error) {
      webFailures.push({ plugin: facet.plugin, error: message(error) });
    }
  };
  const webStep: RolloutStep = {
    name: "web",
    kinds: ["web"],
    reload: async (built) => {
      webFailures = [];
      for (const name of built.removed) web.delete(name);
      for (const [name, plugin] of Object.entries(built.plugins)) if (plugin.facets.web === undefined) web.delete(name);
      for (const facet of built.facets) if (facet.facet === "web") shipWeb(facet);
      const report = { plugins: { added: [], changed: [], removed: [] }, failed: webFailures, objects: [] };
      return { hosts: [{ host: "web", report }] };
    },
  };

  const logProblems = (): void => {
    for (const problem of component.discovery.problems) {
      const key = `${problem.path}\u0000${problem.error}`;
      if (problemsLogged.has(key)) continue;
      problemsLogged.add(key);
      log(
        existsSync(join(problem.path, "plugin.json"))
          ? `plugin ${basename(problem.path)}: skipped: plugin.json is the old shape and is no longer read. ` +
              `Add a package.json with {"name": "${basename(problem.path)}"}, rename host.ts to server.ts and wrap its default export in definePlugin, ` +
              `and delete plugin.json; web.js still works (or rename it to web.tsx). See https://pinomad.si/docs/plugins/`
          : `plugins: skipped ${problem.path}: ${problem.error}`,
      );
    }
  };
  const logFailure = (plugin: string, error: string, signature: string, verb: string): void => {
    if (failedAs.get(plugin) === signature) return;
    failedAs.set(plugin, signature);
    log(`plugin ${plugin}: ${verb}: ${error}`);
  };

  // The first load: each plugin's server half on the chord host, then its browser half.
  const loaded = await component.load(
    host,
    { kind: "server", core: [{ name: CORE, facet: core }], modules: { "@pinomad/plugin/v1": { definePlugin } } },
    context,
  );
  logProblems();
  const composed = await host.registry(PluginExtensions, context);
  const composition = (): Composition => composed.value;
  for (const { plugin, error } of loaded.failed) {
    logFailure(plugin, message(error), signatureOf(component.current("server") ?? [], plugin), "skipped");
  }
  for (const { built } of await component.scripts("web", context)) {
    webFailures = [];
    shipWeb(built);
    for (const failure of webFailures) logFailure(failure.plugin, failure.error, signatureOf([{ built }], failure.plugin), "browser half skipped");
  }

  // The host's registry follows the composition: extensions of removed plugins out, new or changed ones in.
  let mirrored: readonly Extension[] = [];
  const mirror = (): void => {
    const next = composition().installed();
    for (const old of mirrored) if (!next.some((each) => each.name === old.name)) options.registry.uninstall(old);
    for (const each of next) if (!mirrored.includes(each)) options.registry.install(each);
    mirrored = next;
  };
  mirror();
  const unsubscribe = registryReader(composed, context).subscribe(mirror);

  /** Whether a plugin is announced: its server half loaded, or it has only a browser half that built. */
  const announced = (): { name: string; translated?: Translated }[] =>
    component.discovery.plugins.flatMap((plugin) => {
      const translated = composition().plugins.get(plugin.name);
      if (plugin.facets.server !== undefined) return translated === undefined ? [] : [{ name: plugin.name, translated }];
      return web.has(plugin.name) && NAME.test(plugin.name) ? [{ name: plugin.name }] : [];
    });
  const fingerprint = (): Map<string, unknown[]> =>
    new Map(announced().map(({ name, translated }) => [name, [translated, web.get(name)?.hash]]));

  const reload = async (): Promise<void> => {
    // Before the build: its discovery already leaves out a removed plugin.
    const before = fingerprint();
    const built = await component.build(component.state.value.dirty, context);
    logProblems();
    const names = Object.keys(built.plugins);
    if (built.removed.length === 0 && names.every((name) => failedAs.get(name) === signatureOf(built.facets.map((facet) => ({ built: facet })), name))) {
      return;
    }
    const result = await component.rollout([component.step("server", host), webStep], built, context);
    const failed = new Map<string, string>();
    for (const step of result.steps) {
      for (const entry of step.hosts) {
        if ("report" in entry) for (const failure of entry.report.failed) failed.set(failure.plugin, message(failure.error));
        if ("error" in entry) for (const name of names) failed.set(name, message(entry.error));
      }
    }
    if (result.stopped !== undefined) log(`plugins: reload stopped at ${result.stopped.step}: ${message(result.stopped.error)}`);
    const after = fingerprint();
    const outcome: PluginReload = {
      added: [...after.keys()].filter((name) => !before.has(name)),
      changed: [...after.keys()].filter((name) => before.has(name) && before.get(name)!.some((part, index) => part !== after.get(name)![index])),
      removed: [...before.keys()].filter((name) => !after.has(name)),
      failed: [...failed].map(([plugin, error]) => ({ plugin, error })),
    };
    for (const name of [...names, ...built.removed]) if (!failed.has(name)) failedAs.delete(name);
    for (const [plugin, error] of failed) {
      logFailure(plugin, error, signatureOf(built.facets.map((facet) => ({ built: facet })), plugin), "kept the loaded version");
    }
    for (const name of outcome.added) log(`plugin ${name}: loaded`);
    for (const name of outcome.changed) log(`plugin ${name}: reloaded`);
    for (const name of outcome.removed) log(`plugin ${name}: removed`);
    if (outcome.added.length + outcome.changed.length + outcome.removed.length > 0) for (const listener of listeners) listener();
    if (outcome.added.length + outcome.changed.length + outcome.removed.length + outcome.failed.length > 0) options.onReload?.(outcome);
  };

  // chord only marks what changed; this rebuilds what is marked, one reload at a time.
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let again = false;
  let closed = false;
  const schedule = (): void => {
    if (closed) return;
    if (running !== undefined) {
      again = true;
      return;
    }
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      running = reload()
        .catch((error: unknown) => log(`plugins: reload failed: ${message(error)}`))
        .finally(() => {
          running = undefined;
          if (again) {
            again = false;
            schedule();
          }
        });
    }, options.debounceMs ?? 50);
  };
  const watch = await component.state.watch(context);
  watch.start(async (call) => {
    if (call.kind === "value" && (call.value.dirty.length > 0 || call.value.set)) schedule();
  });

  const find = (name: string): { name: string; translated?: Translated } => {
    const plugin = announced().find((each) => each.name === name);
    if (plugin === undefined) throw new Error(`Unknown plugin ${name}`);
    return plugin;
  };
  return {
    get info(): readonly PluginInfo[] {
      return announced().map(({ name }) => {
        const bundle = web.get(name);
        return { name, api: 1, ...(bundle === undefined ? {} : { web: { hash: bundle.hash, size: bundle.size } }) };
      });
    },
    get docs(): readonly ExtensionDoc[] {
      return announced().flatMap(({ translated }) => translated?.docs ?? []);
    },
    bundle: (name, hash) => {
      const code = retained.get(hash);
      if (code === undefined) throw new Error(`Plugin ${name} changed since this connection opened; reconnect to load it`);
      return code;
    },
    method: (plugin, method) => {
      const run = find(plugin).translated?.methods.get(method);
      if (run === undefined) throw new Error(`Unknown method ${method} on plugin ${plugin}`);
      return run;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    close: async () => {
      closed = true;
      clearTimeout(timer);
      await watch.stop();
      await running;
      unsubscribe();
      component.close();
      await host.close(context);
    },
  };
}

/** Each accepted plugin's extension in one Durable snapshot; a plugin taking an earlier plugin's tool name is left out. */
function compose(table: readonly { readonly plugin: string; readonly value: Registration }[], { report }: { report(conflict: { message: string; plugins: readonly string[] }): void }): Composition {
  const registry = createRegistry();
  const plugins = new Map<string, Translated>();
  const owners = new Map<string, string>();
  for (const { plugin, value } of table) {
    if (!NAME.test(plugin)) {
      report({ message: `plugin ${plugin} is skipped: its package.json name must match ${NAME}`, plugins: [plugin] });
      continue;
    }
    const translated = translate(plugin, value);
    const taken = translated.extension.tools?.find((tool) => owners.has(tool.name));
    if (taken !== undefined) {
      const owner = owners.get(taken.name)!;
      report({ message: `plugin ${plugin} is skipped: its tool ${taken.name} is already defined by plugin ${owner}`, plugins: [owner, plugin] });
      continue;
    }
    for (const tool of translated.extension.tools ?? []) owners.set(tool.name, plugin);
    registry.install(translated.extension);
    plugins.set(plugin, translated);
  }
  const snapshot = registry.snapshot();
  return {
    installed: () => snapshot.installed(),
    extension: (name) => snapshot.extension(name),
    tools: () => snapshot.tools(),
    sections: () => snapshot.sections(),
    tasks: () => snapshot.tasks(),
    task: (name) => snapshot.task(name),
    plugins,
  };
}

/**
 * Run a plugin's `definePlugin` function and collect what it registers, checked:
 * this runs while chord evaluates `server.ts`, so a throw fails that evaluation
 * and a reload keeps the version that was loaded.
 */
function collect(plugin: unknown, reserved: ReadonlySet<string>): Registration {
  if (typeof plugin !== "function") throw new Error("definePlugin needs a function");
  const registration: Registration = { states: [], tools: [], methods: new Map() };
  let open = true;
  const guard = (what: string) => {
    if (!open) throw new Error(`${what} must be called while definePlugin's function runs`);
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
      if (!TOOL_NAME.test(name)) throw new Error(`tool name ${JSON.stringify(name)} must match ${TOOL_NAME}`);
      if (name.startsWith("mcp__")) throw new Error(`tool name ${name} is reserved for MCP`);
      if (reserved.has(name)) throw new Error(`tool ${name} is a built-in tool`);
      if (registration.tools.some((tool) => tool.name === name)) throw new Error(`tool ${name} is defined twice`);
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
    const result: unknown = (plugin as HostPlugin)(api);
    if (typeof (result as { then?: unknown } | undefined)?.then === "function") {
      // Refused, but its failure (a throw, or registering after an await) is the plugin's to lose, not an
      // unhandled rejection that takes the host down.
      try {
        (result as PromiseLike<unknown>).then(undefined, () => {});
      } catch {}
      throw new Error("definePlugin's function must register everything before it returns, without awaiting");
    }
  } finally {
    open = false;
  }
  return registration;
}

/** One translation per registration, so an unchanged plugin keeps its extension object across reloads. */
const translations = new WeakMap<Registration, Translated>();

/** A registration as Durable code: documents `plugin.<name>.<state>`, tools that do not replay, methods over a store. */
function translate(plugin: string, registration: Registration): Translated {
  const cached = translations.get(registration);
  if (cached !== undefined) return cached;
  const tokens = new Map<PluginState<unknown>, ConversationDocToken<JsonObject>>();
  const docs: ExtensionDoc[] = [];
  for (const { handle, options } of registration.states) {
    const token = defineDoc<JsonObject>({
      kind: `plugin.${plugin}.${handle.name}`,
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
    if (token === undefined) throw new Error(`State ${state.name} does not belong to plugin ${plugin}`);
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
  const tools = registration.tools.map((tool) =>
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
  const translated: Translated = {
    extension: defineExtension({ name: `plugin.${plugin}`, tools }),
    docs,
    methods: new Map(
      [...registration.methods].map(([name, run]) => [
        name,
        (args: JsonValue, store: PluginStore, conversationId: ConversationId, context: Context) => run(args, contextFor(store, conversationId, context)),
      ]),
    ),
  };
  translations.set(registration, translated);
  return translated;
}

/**
 * chord's browser build as the ES module the shell imports (ADR-0049): the
 * script is a CommonJS function; `react` and JSX's `react/jsx-runtime` are
 * answered with the React the shell hands the default export (so hooks
 * imported from `react` are the shell's), and nothing else can be required.
 * The script runs at the first call of the default export, once that React is
 * known, so JSX at the top level of `web.tsx` works; a script without a default
 * export function fails that call with the error the shell gives an ES module
 * without one.
 */
function webBundle(facet: BuiltFacet): WebBundle {
  if (facet.kind === "failed") throw new Error(facet.errors.join("\n"));
  if (!NAME.test(facet.plugin)) throw new Error(`the package.json name must match ${NAME}`);
  if (facet.css !== undefined || facet.assets.length > 0) {
    throw new Error("the browser half imports CSS or asset files, which plugins cannot ship yet; use inline styles and data: URLs");
  }
  // `jsxs` children are static: passed as arguments, they need no keys.
  const code = `let React;
const element = (type, { children, ...props }, key, spread) => {
  if (key !== undefined) props.key = key;
  if (children === undefined) return React.createElement(type, props);
  return spread ? React.createElement(type, props, ...children) : React.createElement(type, props, children);
};
const runtime = {
  get Fragment() { return React.Fragment; },
  jsx: (type, props, key) => element(type, props, key, false),
  jsxs: (type, props, key) => element(type, props, key, true),
};
let main;
let evaluated = false;
export default function (api) {
  if (!evaluated) {
    React = api.React;
    const module = { exports: {} };
    (
${facet.source}
    )((specifier) => {
      if (specifier === "react/jsx-runtime") return runtime;
      if (specifier === "react") return React;
      throw new Error(specifier + " is not available to a plugin's browser half");
    }, module, module.exports);
    main = module.exports.default;
    evaluated = true;
  }
  if (typeof main !== "function") throw new Error("the browser half has no default export function");
  return main(api);
}
`;
  return { code, hash: createHash("sha256").update(code).digest("hex"), size: Buffer.byteLength(code) };
}

/** A plugin's built files as one string: its facets' digests or build errors. */
function signatureOf(scripts: readonly { readonly built: BuiltFacet }[], plugin: string): string {
  return scripts
    .filter(({ built }) => built.plugin === plugin)
    .map(({ built }) => `${built.facet}:${built.kind === "script" ? built.digest : built.errors.join("\n")}`)
    .sort()
    .join("\n");
}

/** chord's background errors (the host's and the plugins component's) as one line. */
function describe(error: HostError | PluginsError): string {
  if ("message" in error && typeof error.message === "string") return error.message;
  if ("error" in error) return `${error.kind}: ${message(error.error)}`;
  return String((error as { readonly kind: unknown }).kind);
}

const isPlainObject = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

