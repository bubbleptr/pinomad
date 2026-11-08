// Built-in extension: what filled the context window at the last reply, as a
// conversation document clients render beside the context meter. Estimated
// from the request body each provider call sends, stamped with the reply's own
// usage count — the same formula the meter reads, so clients can tell a
// breakdown that belongs to the reply they show from a stale one.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, defineExtension, GenerationTask, hook, type Harness, type TaskId } from "@earendil-works/pi-durable";
import type { CodemodeNamespace } from "@earendil-works/pi-durable/codemode";
import { contextTokens } from "@pinomad/client/context-usage.ts";
import type { ContextBreakdown } from "@pinomad/protocol/presentation.ts";
import type { BuiltinExtension } from "../builtin-extension.ts";
import { breakdownOf, estimateRequest, type RequestEstimate } from "../context-breakdown.ts";

/**
 * Overwritten after every reply, so `latest`. A fork carries its parent's
 * current value: forked at the tip it is the fork's own context too, forked
 * earlier its `used` disagrees with the fork's meter and clients hide it until
 * the fork's first reply. The zero initial value is schema-valid and never
 * matches a meter, so an untouched document never renders as a fallback.
 */
export const ContextBreakdownDoc = defineDoc<ContextBreakdown>({
  kind: "context.breakdown",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ used: 0, system: 0, skills: 0, tools: 0, mcp: 0, messages: 0 }),
  checkpointWhen: () => false,
});

export function createContextBreakdown(options: { readonly harness: () => Harness }): BuiltinExtension {
  let namespaces: readonly CodemodeNamespace[] = [];
  // Each generation's latest request; a retry rebuilds the body and replaces it.
  const pending = new Map<TaskId, RequestEstimate>();
  const build = () =>
    defineExtension({
      name: "context-breakdown",
      hooks: [
        hook(GenerationTask, {
          beforeProviderRequest: (request, api) => {
            const estimate = estimateRequest(request.payload, namespaces);
            if (estimate === undefined) pending.delete(api.taskId);
            else pending.set(api.taskId, estimate);
            return undefined;
          },
          afterResponse: (message, api) => {
            const estimate = pending.get(api.taskId);
            pending.delete(api.taskId);
            // The meter's own rules: a failed or aborted reply, or one without usage, carries no count.
            if (estimate === undefined || message.stopReason === "aborted" || message.stopReason === "error") return;
            const used = message.usage ? contextTokens(message.usage) : 0;
            if (!(used > 0)) return;
            const value = breakdownOf(estimate, used);
            // Detached: a hook must not hold the generation on a document write.
            void options
              .harness()
              .commit(async (tx) => {
                Object.assign(await tx.doc(ContextBreakdownDoc, api.conversationId), value);
              }, BACKGROUND_CONTEXT)
              .catch((error: unknown) => {
                console.error(`context-breakdown: conversation ${api.conversationId}: ${error instanceof Error ? error.message : String(error)}`);
              });
          },
        }),
      ],
    });
  return {
    extension: build(),
    docs: [{ token: ContextBreakdownDoc, presentation: "pinomad.context" }],
    // MCP namespace names split the codemode section; the host calls this whenever they change.
    namespaced: (next) => {
      namespaces = next;
      return build();
    },
  };
}
