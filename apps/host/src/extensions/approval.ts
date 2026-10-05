// Built-in extension (ADR-0004): approval requests as a conversation document.
// The tool writes the request plus a child task that watches for the decision;
// clients decide through the gateway's `decide` call — first writer wins, so
// concurrent deciders cannot disagree (ADR-0005). Cancellation goes through
// the child's own abort protocol: aborting the tool task aborts its owned work
// first, and the child's abort handler commits `cancelled` — a write only a
// fresh abort invocation may do (run-mode commits are rejected after the mark).
import {
  defineDoc,
  defineExtension,
  defineTask,
  defineTool,
  type TaskId,
  type Tx,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import type { ApprovalDecision, ApprovalRequest } from "@pinomad/protocol/presentation.ts";
import type { BuiltinExtension } from "../builtin-extension.ts";

/** The stored request: the presentation shape plus the wait task id, which the schema ignores. */
type RequestRecord = ApprovalRequest & { waitTask: TaskId<ApprovalDecision["outcome"]> };
type ApprovalDocState = { requests: RequestRecord[] };

const ApprovalDoc = defineDoc<ApprovalDocState>({
  kind: "approval.requests",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ requests: [] }),
});

const decisionOf = (value: Readonly<ApprovalDocState> | null, requestId: string): ApprovalDecision["outcome"] | undefined =>
  value?.requests.find((request) => request.id === requestId)?.decision?.outcome;

const createWait = (tx: Tx, owner: TaskId, requestId: string): Promise<TaskId<ApprovalDecision["outcome"]>> =>
  tx.createTask(ApprovalWait, { requestId }, { ownership: { kind: "task", taskId: owner } });

const ApprovalWait = defineTask<{ requestId: string }, { phase: "waiting" }, ApprovalDecision["outcome"]>({
  name: "approval.wait",
  version: 1,
  initial: () => ({ phase: "waiting" }),
  phases: {
    waiting: async (task, runtime, context) => {
      const watch = await runtime.watchDoc(ApprovalDoc, runtime.conversationId, context);
      if (watch === undefined) throw new Error("Approval document is not available");
      try {
        const outcome = await new Promise<ApprovalDecision["outcome"]>((resolve, reject) => {
          const initial = decisionOf(watch.value, task.input.requestId);
          if (initial !== undefined) {
            resolve(initial);
            return;
          }
          watch.start(async (value) => {
            const found = decisionOf(value, task.input.requestId);
            if (found !== undefined) resolve(found);
          });
          // The abort mark only ends this invocation if the phase leaves on its signal.
          runtime.signal.addEventListener("abort", () => reject(runtime.signal.reason ?? new Error("aborted")), { once: true });
        });
        await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: outcome } }), context);
      } finally {
        await watch.stop();
      }
    },
  },
  // Runs in a fresh abort invocation, whose commits are allowed: this is the only
  // place an aborted turn can still record `cancelled`.
  abort: async (task, runtime, context) => {
    await runtime.commit(async (tx) => {
      const doc = await tx.doc(ApprovalDoc, runtime.conversationId);
      const request = doc.requests.find((each) => each.id === task.input.requestId);
      if (request !== undefined && request.decision === undefined) {
        request.decision = { outcome: "cancelled", at: runtime.now() };
      }
      return { status: "terminal", outcome: { status: "aborted", reason: "approval cancelled" } };
    }, context);
  },
});

function result(outcome: ApprovalDecision["outcome"]) {
  return {
    content: [{ type: "text" as const, text: `Approval ${outcome}.` }],
    details: { outcome },
  };
}

const requestApproval = defineTool({
  name: "request_approval",
  description: "Ask the user to approve an action; blocks until they decide.",
  parameters: Type.Object({
    title: Type.String({ minLength: 1 }),
    detail: Type.Optional(Type.String()),
  }),
  // Safe: a rerun finds its request and wait task instead of duplicating them.
  replay: "safe",
  execute: async (args, api, context) => {
    const requestId = api.callId;
    // One commit so the request and its wait task exist atomically.
    const found: { readonly waitTask: TaskId<ApprovalDecision["outcome"]> } | { readonly outcome: ApprovalDecision["outcome"] } =
      await api.commit(async (tx) => {
        const doc = await tx.doc(ApprovalDoc, api.conversationId);
        const existing = doc.requests.find((request) => request.id === requestId);
        if (existing !== undefined) {
          return existing.decision === undefined ? { waitTask: existing.waitTask } : { outcome: existing.decision.outcome };
        }
        const waitTask = await createWait(tx, api.taskId, requestId);
        doc.requests.push({
          id: requestId,
          title: args.title,
          ...(args.detail === undefined ? {} : { detail: args.detail }),
          requestedAt: Date.now(),
          waitTask,
        });
        return { waitTask };
      }, context);
    if ("outcome" in found) return result(found.outcome);
    const settled = await api.waitForTask(found.waitTask, context);
    const outcome = settled.state.outcome.status === "completed" ? settled.state.outcome.result : "cancelled";
    return result(outcome);
  },
});

export const approval: BuiltinExtension = {
  extension: defineExtension({ name: "approval", tools: [requestApproval], tasks: [ApprovalWait] }),
  docs: [{ token: ApprovalDoc, presentation: "pinomad.approval" }],
};
