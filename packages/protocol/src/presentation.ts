// ADR-0005: the runtime-schematized presentation types PiNomad defines for
// extension documents. A client checks `classify` at the boundary and renders
// a design-system view when it passes, the generic fallback otherwise.
// Browser-safe: typebox only.
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

export type PresentationType = "pinomad.todo" | "pinomad.approval";

/** Also used as the `todo_write` tool's `items` element schema on the host. */
export const TodoItemSchema = Type.Object({
  text: Type.String({ minLength: 1 }),
  status: Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")]),
});

export const TodoSchema = Type.Object({ items: Type.Array(TodoItemSchema) });

export type TodoItem = Static<typeof TodoItemSchema>;
export type TodoState = Static<typeof TodoSchema>;

export const ApprovalDecisionSchema = Type.Object({
  outcome: Type.Union([Type.Literal("approved"), Type.Literal("rejected"), Type.Literal("cancelled")]),
  at: Type.Number(),
});

export const ApprovalRequestSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  title: Type.String({ minLength: 1 }),
  detail: Type.Optional(Type.String()),
  requestedAt: Type.Number(),
  decision: Type.Optional(ApprovalDecisionSchema),
});

export const ApprovalSchema = Type.Object({ requests: Type.Array(ApprovalRequestSchema) });

export type ApprovalDecision = Static<typeof ApprovalDecisionSchema>;
export type ApprovalRequest = Static<typeof ApprovalRequestSchema>;
export type ApprovalState = Static<typeof ApprovalSchema>;

export type ClassifiedDoc =
  | { readonly type: "pinomad.todo"; readonly value: TodoState }
  | { readonly type: "pinomad.approval"; readonly value: ApprovalState }
  | { readonly type: "fallback"; readonly value: unknown };

/**
 * Render the typed view only when the host declared a known presentation type
 * AND the value conforms to it. Anything else — including a presentation a
 * newer host invented — falls back so the client never lies about the data.
 */
export function classify(presentation: PresentationType | undefined, value: unknown): ClassifiedDoc {
  if (presentation === "pinomad.todo" && Value.Check(TodoSchema, value)) {
    return { type: "pinomad.todo", value };
  }
  if (presentation === "pinomad.approval" && Value.Check(ApprovalSchema, value)) {
    return { type: "pinomad.approval", value };
  }
  return { type: "fallback", value };
}
