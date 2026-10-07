// ADR-0004: a built-in extension is a Durable extension plus the conversation
// documents it wants clients to see. Core knows extensions only through this
// boundary; the dependency rule is tested in test/extension-boundary.test.ts.
import type { ConversationDocToken, Extension, JsonObject } from "@earendil-works/pi-durable";
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
}
