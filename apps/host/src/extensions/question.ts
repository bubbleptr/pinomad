// Built-in extension (ADR-0011): structured questions as a conversation
// document. The tool writes the request plus a child task that watches for the
// resolution; clients answer through the gateway's `answer` call — first writer
// wins, so concurrent clients cannot disagree (mechanics proven by ADR-0005's
// approval). Cancellation goes through the child's own abort protocol:
// aborting the tool task aborts its owned work first, and the child's abort
// handler commits `cancelled` — a write only a fresh abort invocation may do.
import {
  defineDoc,
  defineExtension,
  defineTask,
  defineTool,
  type TaskId,
  type ToolExecutionResult,
  type Tx,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { QuestionItemSchema, type QuestionItem, type QuestionRequest, type QuestionResolution } from "@pinomad/protocol/presentation.ts";
import type { BuiltinExtension } from "../builtin-extension.ts";

/** The stored request: the presentation shape plus the wait task id, which the schema ignores. */
type RequestRecord = QuestionRequest & { waitTask: TaskId<QuestionResolution> };
type QuestionDocState = { requests: RequestRecord[] };

const QuestionDoc = defineDoc<QuestionDocState>({
  kind: "question.requests",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ requests: [] }),
});

const resolutionOf = (value: Readonly<QuestionDocState> | null, requestId: string): QuestionResolution | undefined =>
  value?.requests.find((request) => request.id === requestId)?.resolution;

const createWait = (tx: Tx, owner: TaskId, requestId: string): Promise<TaskId<QuestionResolution>> =>
  tx.createTask(QuestionWait, { requestId }, { ownership: { kind: "task", taskId: owner } });

const QuestionWait = defineTask<{ requestId: string }, { phase: "waiting" }, QuestionResolution>({
  name: "question.wait",
  version: 1,
  initial: () => ({ phase: "waiting" }),
  phases: {
    waiting: async (task, runtime, context) => {
      const watch = await runtime.watchDoc(QuestionDoc, runtime.conversationId, context);
      if (watch === undefined) throw new Error("Question document is not available");
      try {
        const resolution = await new Promise<QuestionResolution>((resolve, reject) => {
          const initial = resolutionOf(watch.value, task.input.requestId);
          if (initial !== undefined) {
            resolve(initial);
            return;
          }
          watch.start(async (value) => {
            const found = resolutionOf(value, task.input.requestId);
            if (found !== undefined) resolve(found);
          });
          // The abort mark only ends this invocation if the phase leaves on its signal.
          runtime.signal.addEventListener("abort", () => reject(runtime.signal.reason ?? new Error("aborted")), { once: true });
        });
        await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: resolution } }), context);
      } finally {
        await watch.stop();
      }
    },
  },
  // Runs in a fresh abort invocation, whose commits are allowed: this is the only
  // place an aborted turn can still record `cancelled`.
  abort: async (task, runtime, context) => {
    await runtime.commit(async (tx) => {
      const doc = await tx.doc(QuestionDoc, runtime.conversationId);
      const request = doc.requests.find((each) => each.id === task.input.requestId);
      if (request !== undefined && request.resolution === undefined) {
        request.resolution = { outcome: "cancelled", at: runtime.now() };
      }
      return { status: "terminal", outcome: { status: "aborted", reason: "question cancelled" } };
    }, context);
  },
});

function result(questions: readonly QuestionItem[], resolution: QuestionResolution): ToolExecutionResult {
  let text: string;
  if (resolution.outcome === "answered") {
    text = resolution.answers
      .map((answer, index) => {
        const header = questions[index]?.header ?? `Q${index + 1}`;
        if (answer.selected.length === 0 && answer.other === undefined) return `${header}: (skipped)`;
        const parts = [answer.selected.join(", "), ...(answer.other === undefined ? [] : [`other: "${answer.other}"`])];
        return `${header}: ${parts.filter((part) => part !== "").join("; ")}`;
      })
      .join("\n");
  } else if (resolution.outcome === "dismissed") {
    text = "The user did not answer and replied in the conversation instead; read their next message.";
  } else {
    text = "Question cancelled.";
  }
  return { content: [{ type: "text", text }], details: { resolution } };
}

const askUserQuestion = defineTool({
  name: "ask_user_question",
  description:
    "Ask the user 1–4 multiple-choice questions when their decision is needed to proceed (ambiguous requirements, choosing between approaches, scope). Blocks until answered. The user can always type a custom answer, so never add an 'Other' option. Keep headers short.",
  parameters: Type.Object({
    questions: Type.Array(QuestionItemSchema, { minItems: 1, maxItems: 4 }),
  }),
  // Safe: a rerun finds its request and wait task instead of duplicating them.
  replay: "safe",
  execute: async (args, api, context) => {
    const requestId = api.callId;
    // One commit so the request and its wait task exist atomically.
    const found: { readonly waitTask: TaskId<QuestionResolution> } | { readonly resolution: QuestionResolution } =
      await api.commit(async (tx) => {
        const doc = await tx.doc(QuestionDoc, api.conversationId);
        const existing = doc.requests.find((request) => request.id === requestId);
        if (existing !== undefined) {
          return existing.resolution === undefined ? { waitTask: existing.waitTask } : { resolution: existing.resolution };
        }
        const waitTask = await createWait(tx, api.taskId, requestId);
        doc.requests.push({ id: requestId, questions: args.questions, askedAt: Date.now(), waitTask });
        return { waitTask };
      }, context);
    if ("resolution" in found) return result(args.questions, found.resolution);
    const settled = await api.waitForTask(found.waitTask, context);
    const resolution =
      settled.state.outcome.status === "completed" ? settled.state.outcome.result : ({ outcome: "cancelled", at: Date.now() } as const);
    return result(args.questions, resolution);
  },
});

export const question: BuiltinExtension = {
  extension: defineExtension({ name: "question", tools: [askUserQuestion], tasks: [QuestionWait] }),
  // Nested in a script the question would block with no user visible prompt (ADR-0013 §2).
  modelOnly: ["ask_user_question"],
  docs: [{ token: QuestionDoc, presentation: "pinomad.question" }],
};
