// ADR-0005: the runtime-schematized presentation types PiNomad defines for
// extension documents and tool-result details. A client checks `classify` at
// the boundary and renders a design-system view when it passes, the generic
// fallback otherwise. Browser-safe: typebox only.
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

export type PresentationType = "pinomad.todo" | "pinomad.question" | "pinomad.diff";

/** Also used as the `todo_write` tool's `items` element schema on the host. */
export const TodoItemSchema = Type.Object({
  text: Type.String({ minLength: 1 }),
  status: Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")]),
});

export const TodoSchema = Type.Object({ items: Type.Array(TodoItemSchema) });

export type TodoItem = Static<typeof TodoItemSchema>;
export type TodoState = Static<typeof TodoSchema>;

/** Also used as the `ask_user_question` tool's `questions` element schema on the host. */
export const QuestionOptionSchema = Type.Object({
  label: Type.String({ minLength: 1 }),
  description: Type.Optional(Type.String()),
});

export const QuestionItemSchema = Type.Object({
  question: Type.String({ minLength: 1 }),
  header: Type.String({ minLength: 1, maxLength: 16 }),
  options: Type.Array(QuestionOptionSchema, { minItems: 2, maxItems: 4 }),
  multiSelect: Type.Optional(Type.Boolean()),
});

/** Labels chosen from a question's options; empty `selected` with no `other` means skipped. */
export const QuestionAnswerSchema = Type.Object({
  selected: Type.Array(Type.String()),
  other: Type.Optional(Type.String()),
});

export const QuestionResolutionSchema = Type.Union([
  Type.Object({ outcome: Type.Literal("answered"), answers: Type.Array(QuestionAnswerSchema), at: Type.Number() }),
  /** The user replied in chat instead (ADR-0011 §4). */
  Type.Object({ outcome: Type.Literal("dismissed"), at: Type.Number() }),
  Type.Object({ outcome: Type.Literal("cancelled"), at: Type.Number() }),
]);

export const QuestionRequestSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  questions: Type.Array(QuestionItemSchema, { minItems: 1, maxItems: 4 }),
  askedAt: Type.Number(),
  resolution: Type.Optional(QuestionResolutionSchema),
});

export const QuestionSchema = Type.Object({ requests: Type.Array(QuestionRequestSchema) });

export type QuestionOption = Static<typeof QuestionOptionSchema>;
export type QuestionItem = Static<typeof QuestionItemSchema>;
export type QuestionAnswer = Static<typeof QuestionAnswerSchema>;
export type QuestionResolution = Static<typeof QuestionResolutionSchema>;
export type QuestionRequest = Static<typeof QuestionRequestSchema>;
export type QuestionState = Static<typeof QuestionSchema>;

/**
 * A tool result's `details` carries a unified patch (ADR-0005). Extra fields
 * are allowed: Durable's edit details also ship `diff` and `firstChangedLine`.
 */
export const DiffSchema = Type.Object({ patch: Type.String() });

export type DiffDetails = Static<typeof DiffSchema>;

export type ClassifiedDoc =
  | { readonly type: "pinomad.todo"; readonly value: TodoState }
  | { readonly type: "pinomad.question"; readonly value: QuestionState }
  | { readonly type: "pinomad.diff"; readonly value: DiffDetails }
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
  if (presentation === "pinomad.question" && Value.Check(QuestionSchema, value)) {
    return { type: "pinomad.question", value };
  }
  if (presentation === "pinomad.diff" && Value.Check(DiffSchema, value)) {
    return { type: "pinomad.diff", value };
  }
  return { type: "fallback", value };
}
