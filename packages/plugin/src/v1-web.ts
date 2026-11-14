// Plugin API v1, browser half (ADR-0049, ADR-0050). A plugin's `web.tsx` (or
// `web.js`) default-exports a function that receives a WebApi and registers
// its panels and tool cards; the host builds it into one script. Import these
// with `import type` only. JSX and an `import` of `react` both get the shell's
// React, the same one as the argument's `React`; no other React package is
// available.
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

export interface SandboxProps {
  /** A whole document; its scripts run, isolated from the client. A new value starts a new document. */
  readonly html: string;
  /** The frame's accessible name. */
  readonly title: string;
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
  /**
   * Renders model-written HTML, scripts included, in a frame that cannot reach
   * anything of the client: not its device key, its storage or the shell's
   * page. Network access is not part of the promise: fetches, navigation and
   * external resources are blocked as best effort, and WebRTC is not blocked.
   * It fills its slot.
   */
  readonly Sandbox: ComponentType<SandboxProps>;
}

/** The default export of a plugin's `web.tsx`. */
export type WebPlugin = (pinomad: WebApi) => void;
