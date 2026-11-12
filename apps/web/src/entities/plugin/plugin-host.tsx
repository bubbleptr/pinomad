// Plugin UI in the shell (ADR-0049). One PluginHostProvider per host
// connection loads that host's bundles and keeps their registrations; they go
// when the connection does. Slot components read the shown conversation from
// PluginScope, which the workbench (main column) and a side transcript set.
import * as React from "react";
import { Component, createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { JsonValue, WebApi } from "@pinomad/plugin/v1/web";
import type { PluginInfo } from "@pinomad/protocol/frames.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import type { ExtensionDocView } from "@pinomad/protocol/view.ts";
import { useDurableView } from "../../use-remote.ts";
import {
  EMPTY_PLUGIN_REGISTRY,
  evaluateBlobModule,
  loadPlugins,
  pluginSurface,
  type EvaluateModule,
  type PluginRegistry,
  type PluginSurfaceId,
  type Registrar,
} from "./load-plugins.ts";

/**
 * What a WebApi's non-hook calls (`call`, `openPanel`) reach outside React:
 * the main column's conversation and the side panel's opener, set by the
 * focused workbench.
 */
interface PluginBridge {
  conversationId: ConversationId | undefined;
  openSurface: ((surface: PluginSurfaceId) => void) | undefined;
}

interface PluginHost {
  readonly registry: PluginRegistry;
  readonly bridge: PluginBridge | undefined;
}

const PluginHostContext = createContext<PluginHost>({ registry: EMPTY_PLUGIN_REGISTRY, bridge: undefined });

interface Scope {
  readonly conversationId: ConversationId | undefined;
  readonly docs: readonly ExtensionDocView[];
}

const ScopeContext = createContext<Scope>({ conversationId: undefined, docs: [] });

/** Which plugins to load, as a stable key: a new hello with the same bundles keeps the registrations. */
function bundlesKey(plugins: readonly PluginInfo[] | undefined): string {
  return JSON.stringify((plugins ?? []).flatMap((plugin) => (plugin.web === undefined ? [] : [[plugin.name, plugin.web.hash]])));
}

function webApi(plugin: string, registrar: Registrar, remote: RemoteDurable, bridge: PluginBridge): WebApi {
  const kindOf = (stateName: string) => `plugin.${plugin}.${stateName}`;
  return {
    React,
    panel: registrar.panel,
    toolCard: registrar.toolCard,
    useState: <T,>(stateName: string) => {
      const { docs } = useContext(ScopeContext);
      return (docs.find((doc) => doc.kind === kindOf(stateName))?.value ?? undefined) as T | undefined;
    },
    useCall: <T,>(method: string, args: JsonValue | undefined, deps: readonly unknown[]) => {
      const { conversationId } = useContext(ScopeContext);
      const [result, setResult] = useState<{ readonly conversationId: ConversationId; readonly value: T }>();
      const argsKey = args === undefined ? undefined : JSON.stringify(args);
      useEffect(() => {
        if (argsKey === undefined || conversationId === undefined) return;
        let live = true;
        remote.plugins.call(conversationId, plugin, method, JSON.parse(argsKey) as JsonValue).then(
          (value) => {
            if (live) setResult({ conversationId, value: value as T });
          },
          (error: unknown) => console.error(`Plugin ${plugin}: ${method} failed`, error),
        );
        return () => {
          live = false;
        };
        // The plugin's deps decide when to call again, like useEffect's.
      }, [conversationId, method, argsKey, ...deps]);
      return result?.conversationId === conversationId ? result?.value : undefined;
    },
    call: async <T,>(method: string, args: JsonValue) => {
      const conversationId = bridge.conversationId;
      if (conversationId === undefined) throw new Error("No conversation is shown");
      return (await remote.plugins.call(conversationId, plugin, method, args)) as T;
    },
    openPanel: (id) => bridge.openSurface?.(pluginSurface(plugin, id)),
  };
}

/** Loads the connected host's plugin bundles; mount it for as long as the connection lives. */
export function PluginHostProvider({
  remote,
  evaluate = evaluateBlobModule,
  children,
}: {
  remote: RemoteDurable;
  evaluate?: EvaluateModule;
  children: ReactNode;
}) {
  const plugins = useDurableView(remote).host?.plugins;
  const key = bundlesKey(plugins);
  const bridge = useMemo<PluginBridge>(() => ({ conversationId: undefined, openSurface: undefined }), [remote]);
  const [registry, setRegistry] = useState(EMPTY_PLUGIN_REGISTRY);
  // Read through the key, so the effect runs when the bundles change and not on every view.
  const toLoad = useMemo(() => plugins ?? [], [key]);
  useEffect(() => {
    setRegistry(EMPTY_PLUGIN_REGISTRY);
    if (!toLoad.some((plugin) => plugin.web !== undefined)) return;
    let live = true;
    void loadPlugins(toLoad, {
      bundle: (name) => remote.plugins.bundle(name),
      evaluate,
      api: (name, registrar) => webApi(name, registrar, remote, bridge),
    }).then((loaded) => {
      if (live) setRegistry(loaded);
    });
    return () => {
      live = false;
    };
  }, [bridge, evaluate, remote, toLoad]);
  const host = useMemo(() => ({ registry, bridge }), [registry, bridge]);
  return <PluginHostContext.Provider value={host}>{children}</PluginHostContext.Provider>;
}

export function usePluginRegistry(): PluginRegistry {
  return useContext(PluginHostContext).registry;
}

/**
 * The focused workbench's hook: points `call` and `openPanel` at its main
 * conversation and side panel, and returns the registrations to show.
 */
export function usePluginWorkbench(
  conversationId: ConversationId | undefined,
  openSurface: (surface: PluginSurfaceId) => void,
): PluginRegistry {
  const { registry, bridge } = useContext(PluginHostContext);
  useEffect(() => {
    if (bridge === undefined) return;
    bridge.conversationId = conversationId;
    bridge.openSurface = openSurface;
  }, [bridge, conversationId, openSurface]);
  return registry;
}

/** The conversation slot components below read their state and calls against. */
export function PluginScope({
  conversationId,
  docs,
  children,
}: {
  conversationId: ConversationId | undefined;
  docs: readonly ExtensionDocView[];
  children: ReactNode;
}) {
  const scope = useMemo(() => ({ conversationId, docs }), [conversationId, docs]);
  return <ScopeContext.Provider value={scope}>{children}</ScopeContext.Provider>;
}

/** One plugin slot: a throwing plugin component shows a line instead of taking its surroundings down. */
export class PluginSlot extends Component<{ plugin: string; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: unknown): void {
    console.error(`Plugin ${this.props.plugin} failed to render`, error);
  }

  override render(): ReactNode {
    if (this.state.failed) {
      return <p className="px-3 py-2 text-xs/5 text-muted-foreground">{`The ${this.props.plugin} plugin could not show this.`}</p>;
    }
    return this.props.children;
  }
}
