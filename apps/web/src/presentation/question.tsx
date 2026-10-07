// Pending `pinomad.question` requests (ADR-0011): rendered above the composer so
// the agent's question is unmissable on any screen size. One Submit sends every
// question's answers at once — untouched questions count as skipped. The
// resolved read-only view lives in documents.tsx.
import { useState, type CSSProperties } from "react";
import { Button } from "@astryxdesign/core/Button";
import { CheckboxList, CheckboxListItem } from "@astryxdesign/core/CheckboxList";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { RadioList, RadioListItem } from "@astryxdesign/core/RadioList";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Token } from "@astryxdesign/core/Token";
import { classify, type QuestionAnswer, type QuestionRequest } from "@pinomad/protocol/presentation.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import type { DurableView } from "@pinomad/protocol/view.ts";

const card: CSSProperties = {
  border: "1px solid var(--color-border-primary, var(--color-background-muted))",
  borderRadius: "var(--radius-md, 8px)",
  padding: "var(--space-3, 12px)",
  backgroundColor: "var(--color-background-surface)",
};

/** Unresolved question requests across the shown conversation's docs, in doc order. */
export function PendingQuestions({ view, remote }: { view: DurableView; remote: RemoteDurable }) {
  const pending = view.docs.flatMap((doc) => {
    const classified = classify(doc.presentation, doc.value);
    if (classified.type !== "pinomad.question") return [];
    return classified.value.requests
      .filter((request) => request.resolution === undefined)
      .map((request) => ({ kind: doc.kind, request }));
  });
  if (pending.length === 0) return null;
  return (
    <VStack gap={2} padding={2} data-testid="pending-questions">
      {pending.map(({ kind, request }) => (
        <QuestionCard key={request.id} kind={kind} request={request} remote={remote} connected={view.connection === "connected"} />
      ))}
    </VStack>
  );
}

function QuestionCard({
  kind,
  request,
  remote,
  connected,
}: {
  kind: string;
  request: QuestionRequest;
  remote: RemoteDurable;
  connected: boolean;
}) {
  const [selections, setSelections] = useState<string[][]>(() => request.questions.map(() => []));
  const [others, setOthers] = useState<string[]>(() => request.questions.map(() => ""));
  const setSelection = (index: number, selected: string[]): void =>
    setSelections((prev) => prev.map((each, i) => (i === index ? selected : each)));
  const setOther = (index: number, other: string): void =>
    setOthers((prev) => prev.map((each, i) => (i === index ? other : each)));

  const submit = (): void => {
    const answers: QuestionAnswer[] = request.questions.map((_, index) => ({
      selected: selections[index] ?? [],
      ...(others[index]?.trim() === "" ? {} : { other: others[index] }),
    }));
    void remote.controller.answer(kind, request.id, answers);
  };

  return (
    <VStack gap={3} style={card}>
      <Text type="label" weight="semibold">The agent asks</Text>
      {request.questions.map((question, index) => (
        <VStack key={index} gap={1}>
          <HStack gap={2} vAlign="center">
            <Token label={question.header} size="sm" />
            <Text type="body">{question.question}</Text>
          </HStack>
          {question.multiSelect === true ? (
            <CheckboxList
              label={question.header}
              isLabelHidden
              value={selections[index] ?? []}
              onChange={(selected) => setSelection(index, selected)}
            >
              {question.options.map((option) => (
                <CheckboxListItem key={option.label} label={option.label} value={option.label} {...(option.description === undefined ? {} : { description: option.description })} />
              ))}
            </CheckboxList>
          ) : (
            <RadioList
              label={question.header}
              isLabelHidden
              value={selections[index]?.[0] ?? ""}
              onChange={(selected) => setSelection(index, [selected])}
            >
              {question.options.map((option) => (
                <RadioListItem key={option.label} label={option.label} value={option.label} {...(option.description === undefined ? {} : { description: option.description })} />
              ))}
            </RadioList>
          )}
          <TextInput
            label="Other"
            value={others[index] ?? ""}
            onChange={(value) => setOther(index, value)}
            placeholder="Type a custom answer…"
          />
        </VStack>
      ))}
      <HStack hAlign="end">
        <Button label="Submit" variant="primary" isDisabled={!connected} onClick={submit} />
      </HStack>
    </VStack>
  );
}
