// ADR-0004: a built-in extension is a Durable extension plus the conversation
// documents it wants clients to see. Core knows extensions only through this
// boundary; the dependency rule is tested in test/extension-boundary.test.ts.
import type { ConversationDocToken, Extension, JsonObject } from "@earendil-works/pi-durable";
import type { CodemodeNamespace } from "@earendil-works/pi-durable/codemode";
import type { PresentationType } from "@pinomad/protocol/presentation.ts";

export interface ExtensionDoc {
  readonly token: ConversationDocToken<JsonObject>;
  /** How clients render it; absent means fallback rendering. */
  readonly presentation?: PresentationType;
}

export interface BuiltinExtension {
  readonly extension: Extension;
  readonly docs?: readonly ExtensionDoc[];
  /** Tool name → presentation of its result `details` (ADR-0005). */
  readonly tools?: Readonly<Record<string, PresentationType>>;
  /**
   * Rebuild the extension with the current script-tool namespaces (MCP
   * servers, ADR-0013 §5); the host reinstalls the result when they change.
   */
  readonly namespaced?: (namespaces: readonly CodemodeNamespace[]) => Extension;
  /** Resources the extension owns process-wide, such as a sandbox pool. */
  readonly close?: () => Promise<void>;
}
