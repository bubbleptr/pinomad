// A host's plugin bundles turned into slot registrations (ADR-0049). Each
// `web.js` is fetched over the connection, checked against the hash the hello
// announced, evaluated as an ES module, and its default export called with a
// WebApi. A plugin that fails any step is skipped; the others still load.
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { ComponentType } from "react";
import type { PluginToolCall, WebApi } from "@pinomad/plugin/v1/web";
import type { PluginInfo } from "@pinomad/protocol/frames.ts";

export type PluginSurfaceId = `plugin:${string}`;

/** A side-panel surface; `surface` keys it so two plugins' ids cannot collide. */
export interface PluginPanel {
  readonly plugin: string;
  readonly surface: PluginSurfaceId;
  readonly label: string;
  readonly component: ComponentType;
}

export interface PluginToolCard {
  readonly plugin: string;
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
  bundle: (name: string) => Promise<string>,
  evaluate: EvaluateModule,
): Promise<unknown> {
  const { hash } = plugin.web;
  let loaded = evaluated.get(hash);
  if (loaded === undefined) {
    loaded = bundle(plugin.name).then((code) => evaluate(verified(code, hash))).then((module) => module.default);
    evaluated.set(hash, loaded);
    // A failure may be the connection's; let the next load try again.
    loaded.catch(() => evaluated.delete(hash));
  }
  return loaded;
}

async function register(
  plugin: PluginInfo & { readonly web: NonNullable<PluginInfo["web"]> },
  options: LoadOptions,
): Promise<{ panels: PluginPanel[]; toolCards: [string, PluginToolCard][] }> {
  const main = await defaultExport(plugin, options.bundle, options.evaluate);
  if (typeof main !== "function") throw new Error("web.js has no default export function");
  const panels: PluginPanel[] = [];
  const toolCards: [string, PluginToolCard][] = [];
  let open = true;
  const registrar: Registrar = {
    panel: ({ id, label, component }) => {
      if (!open) return console.error(`Plugin ${plugin.name}: panel ${id} registered after setup; ignored`);
      panels.push({ plugin: plugin.name, surface: pluginSurface(plugin.name, id), label, component });
    },
    toolCard: (toolName, component) => {
      if (!open) return console.error(`Plugin ${plugin.name}: tool card ${toolName} registered after setup; ignored`);
      toolCards.push([toolName, { plugin: plugin.name, component }]);
    },
  };
  try {
    (main as (api: WebApi) => void)(options.api(plugin.name, registrar));
  } finally {
    open = false;
  }
  return { panels, toolCards };
}

export interface LoadOptions {
  readonly bundle: (name: string) => Promise<string>;
  readonly evaluate: EvaluateModule;
  /** The WebApi handed to `name`'s default export; its `panel` / `toolCard` must forward to `registrar`. */
  readonly api: (name: string, registrar: Registrar) => WebApi;
}

/**
 * Every plugin with a browser half, loaded in parallel; a failing one is
 * logged once and left out, and `failed` says whether any was.
 */
export async function loadPlugins(
  plugins: readonly PluginInfo[],
  options: LoadOptions,
): Promise<{ registry: PluginRegistry; failed: boolean }> {
  const loaded = await Promise.all(
    plugins.map(async (plugin) => {
      const web = plugin.web;
      if (web === undefined) return { panels: [], toolCards: [] };
      try {
        return await register({ ...plugin, web }, options);
      } catch (error) {
        console.error(`Plugin ${plugin.name} was not loaded:`, error);
        return undefined;
      }
    }),
  );
  const panels: PluginPanel[] = [];
  const toolCards = new Map<string, PluginToolCard>();
  let failed = false;
  for (const entry of loaded) {
    if (entry === undefined) {
      failed = true;
      continue;
    }
    panels.push(...entry.panels);
    for (const [name, card] of entry.toolCards) if (!toolCards.has(name)) toolCards.set(name, card);
  }
  return { registry: { panels, toolCards }, failed };
}
