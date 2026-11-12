// Plugin API v1, browser half (ADR-0049). A plugin's `web.js` is an ES module
// whose default export receives a WebApi and registers its panels and tool
// cards. Import these with `import type` only, and take React from the
// argument: the shell evaluates `web.js` as a standalone module, so a bundled
// copy of React would not share the shell's hooks.
import type { ComponentType } from "react";
import type { JsonValue } from "./v1.ts";

export type { JsonValue } from "./v1.ts";

/** A tool call as a tool card sees it. */
export interface PluginToolCall {
  readonly name: string;
  /** The parsed arguments; undefined while they stream in or when they are not JSON. */
  readonly args: JsonValue | undefined;
  /** The result text the model saw; undefined until the call settles. */
  readonly output: string | undefined;
  readonly state: string;
}

export interface PanelDefinition {
  /** Unique within this plugin. */
  readonly id: string;
  /** The surface button's accessible name and tooltip. */
  readonly label: string;
  readonly component: ComponentType;
}

export interface WebApi {
  /** The shell's React; use it for elements and hooks. */
  readonly React: typeof import("react");
  /** A side-panel surface. */
  panel(definition: PanelDefinition): void;
  /** Replaces the detail of every call of `toolName` in the transcript. */
  toolCard(toolName: string, component: ComponentType<{ tool: PluginToolCall }>): void;
  /** Hook: this plugin's shared state for the shown conversation; undefined until it arrived. */
  useState<T = JsonValue>(stateName: string): T | undefined;
  /** Hook: a host method's result, called again when `deps` change; undefined `args` skips the call. */
  useCall<T = JsonValue>(method: string, args: JsonValue | undefined, deps: readonly unknown[]): T | undefined;
  /** Calls one of this plugin's host methods for the shown conversation. */
  call<T = JsonValue>(method: string, args: JsonValue): Promise<T>;
  /** Opens one of this plugin's panels by id. */
  openPanel(id: string): void;
}

/** The default export of a plugin's `web.js`. */
export type WebPlugin = (pinomad: WebApi) => void;
