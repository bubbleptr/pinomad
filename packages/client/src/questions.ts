// Pending `pinomad.question` requests (ADR-0011), shared so every client
// renders the same card above its composer. DOM-free.
import { classify, type QuestionAnswer, type QuestionRequest } from "@pinomad/protocol/presentation.ts";
import type { ExtensionDocView } from "@pinomad/protocol/view.ts";

/** The unresolved `pinomad.question` requests across docs, in doc order. */
export function pendingQuestions(
  docs: readonly ExtensionDocView[],
): { kind: string; request: QuestionRequest }[] {
  return docs.flatMap((doc) => {
    const classified = classify(doc.presentation, doc.value);
    if (classified.type !== "pinomad.question") return [];
    return classified.value.requests
      .filter((request) => request.resolution === undefined)
      .map((request) => ({ kind: doc.kind, request }));
  });
}

/**
 * One card's answers: untouched questions submit an empty selection, and a
 * blank or unset "other" is omitted rather than sent as an empty string.
 */
export function questionAnswers(
  questionCount: number,
  selections: readonly string[][],
  others: readonly string[],
): QuestionAnswer[] {
  return Array.from({ length: questionCount }, (_, index) => ({
    selected: selections[index] ?? [],
    ...(others[index] === undefined || others[index].trim() === "" ? {} : { other: others[index] }),
  }));
}
