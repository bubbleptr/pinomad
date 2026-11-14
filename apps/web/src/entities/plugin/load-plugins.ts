// A host's plugin bundles turned into slot registrations (ADR-0049). Each
// browser half (`web.tsx`, built by the host) is fetched over the connection,
// checked against the hash the host announced, evaluated as an ES module, and
// its default export called with a WebApi. A plugin that fails any step is
// skipped, or keeps the version it had; the others still load.
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { ComponentType } from "react";
import type { PluginToolCall, WebApi } from "@pinomad/plugin/v1/web";
import type { PluginInfo } from "@pinomad/protocol/frames.ts";

export type PluginSurfaceId = `plugin:${string}`;

/** A side-panel surface; `surface` keys it so two plugins' ids cannot collide. */
export interface PluginPanel {
  readonly plugin: string;
  /** The bundle that registered it: a slot showing it starts over when this changes. */
  readonly hash: string;
  readonly surface: PluginSurfaceId;
  readonly label: string;
  readonly component: ComponentType;
}

export interface PluginToolCard {
  readonly plugin: string;
  /** The bundle that registered it: a slot showing it starts over when this changes. */
  readonly hash: string;
  readonly component: ComponentType<{ tool: PluginToolCall }>;
}

export interface PluginRegistry {
  /** In hello order, each plugin's in registration order. */
  readonly panels: readonly PluginPanel[];
  /** By tool name; the first plugin to claim a name keeps it. */
  readonly toolCards: ReadonlyMap<string, PluginToolCard>;
}

export const EMPTY_PLUGIN_REGISTRY: PluginRegistry = { panels: [], toolCards: new Map() };

export const pluginSurface = (plugin: string, id: string): PluginSurfaceId => `plugin:${plugin}:${id}`;

/** Turns module source into its namespace; jsdom tests replace it. */
export type EvaluateModule = (code: string) => Promise<{ readonly default?: unknown }>;

/** A `blob:` module import; the page CSP's `script-src` allows `blob:` for this. */
export const evaluateBlobModule: EvaluateModule = async (code) => {
  const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
  try {
    return (await import(/* @vite-ignore */ url)) as { readonly default?: unknown };
  } finally {
    URL.revokeObjectURL(url);
  }
};

export type Registrar = Pick<WebApi, "panel" | "toolCard">;

/**
 * Default exports by bundle hash, for the page's lifetime: a reconnect or a
 * second host with the same bundle neither fetches nor evaluates it again.
 */
const evaluated = new Map<string, Promise<unknown>>();

function verified(code: string, hash: string): string {
  const actual = bytesToHex(sha256(new TextEncoder().encode(code)));
  if (actual !== hash) throw new Error(`bundle hash ${actual} does not match the announced ${hash}`);
  return code;
}

function defaultExport(
  plugin: PluginInfo & { readonly web: NonNullable<PluginInfo["web"]> },
  bundle: LoadOptions["bundle"],
  evaluate: EvaluateModule,
): Promise<unknown> {
  const { hash } = plugin.web;
  let loaded = evaluated.get(hash);
  if (loaded === undefined) {
    loaded = bundle(plugin.name, hash).then((code) => evaluate(verified(code, hash))).then((module) => module.default);
    evaluated.set(hash, loaded);
    // A failure may be the connection's; let the next load try again.
    loaded.catch(() => evaluated.delete(hash));
  }
  return loaded;
}

/** One plugin's registrations, from the bundle `hash`. */
export interface LoadedPlugin {
  readonly hash: string;
  readonly panels: readonly PluginPanel[];
  readonly toolCards: readonly (readonly [string, PluginToolCard])[];
}

async function register(plugin: PluginInfo & { readonly web: NonNullable<PluginInfo["web"]> }, options: LoadOptions): Promise<LoadedPlugin> {
  const { hash } = plugin.web;
  const main = await defaultExport(plugin, options.bundle, options.evaluate);
  if (typeof main !== "function") throw new Error("the browser half has no default export function");
  const panels: PluginPanel[] = [];
  const toolCards: [string, PluginToolCard][] = [];
  let open = true;
  const registrar: Registrar = {
    panel: ({ id, label, component }) => {
      if (!open) return console.error(`Plugin ${plugin.name}: panel ${id} registered after setup; ignored`);
      panels.push({ plugin: plugin.name, hash, surface: pluginSurface(plugin.name, id), label, component });
    },
    toolCard: (toolName, component) => {
      if (!open) return console.error(`Plugin ${plugin.name}: tool card ${toolName} registered after setup; ignored`);
      toolCards.push([toolName, { plugin: plugin.name, hash, component }]);
    },
  };
  try {
    (main as (api: WebApi) => void)(options.api(plugin.name, registrar));
  } finally {
    open = false;
  }
  return { hash, panels, toolCards };
}

export interface LoadOptions {
  /** Plugin `name`'s bundle announced with `hash`. */
  readonly bundle: (name: string, hash: string) => Promise<string>;
  readonly evaluate: EvaluateModule;
  /** The WebApi handed to `name`'s default export; its `panel` / `toolCard` must forward to `registrar`. */
  readonly api: (name: string, registrar: Registrar) => WebApi;
}

/**
 * Every plugin with a browser half, loaded in parallel. One `previous` holds
 * with the same bundle is kept as it is: its setup does not run again, so its
 * components keep their identity and stay mounted. A failing one is logged
 * once and keeps its `previous` version, or is left out without one; `failed`
 * says whether any failed. `loaded` is the `previous` of the next load.
 */
export async function loadPlugins(
  plugins: readonly PluginInfo[],
  options: LoadOptions,
  previous: ReadonlyMap<string, LoadedPlugin> = new Map(),
): Promise<{ registry: PluginRegistry; loaded: ReadonlyMap<string, LoadedPlugin>; failed: boolean }> {
  let failed = false;
  const results = await Promise.all(
    plugins.map(async (plugin): Promise<[string, LoadedPlugin] | undefined> => {
      const web = plugin.web;
      if (web === undefined) return undefined;
      const before = previous.get(plugin.name);
      if (before?.hash === web.hash) return [plugin.name, before];
      try {
        return [plugin.name, await register({ ...plugin, web }, options)];
      } catch (error) {
        console.error(`Plugin ${plugin.name} was not loaded:`, error);
        failed = true;
        return before === undefined ? undefined : [plugin.name, before];
      }
    }),
  );
  const loaded = new Map(results.filter((entry) => entry !== undefined));
  const panels: PluginPanel[] = [];
  const toolCards = new Map<string, PluginToolCard>();
  for (const entry of loaded.values()) {
    panels.push(...entry.panels);
    for (const [name, card] of entry.toolCards) if (!toolCards.has(name)) toolCards.set(name, card);
  }
  return { registry: { panels, toolCards }, loaded, failed };
}

