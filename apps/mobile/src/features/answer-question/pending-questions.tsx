// Pending `pinomad.question` requests, rendered above the composer — the
// agent's question is unmissable. One Submit sends every question's answers;
// untouched questions count as skipped (questionAnswers omits blank others).
import { useState } from "react";
import { ScrollView, Text, TextInput, useWindowDimensions, View } from "react-native";
import { Button, Card, Checkbox, Chip, Radio, RadioGroup } from "heroui-native";
import { useCSSVariable } from "uniwind";
import type { QuestionRequest } from "@pinomad/protocol/presentation.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import type { ExtensionDocView } from "@pinomad/protocol/view.ts";
import { pendingQuestions, questionAnswers } from "@pinomad/client/questions.ts";

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
  const fieldPlaceholder = useCSSVariable("--field-placeholder") as string | undefined;
  const setSelection = (index: number, selected: string[]): void =>
    setSelections((previous) => previous.map((each, i) => (i === index ? selected : each)));
  const setOther = (index: number, other: string): void =>
    setOthers((previous) => previous.map((each, i) => (i === index ? other : each)));

  const submit = (): void => {
    void remote.controller.answer(kind, request.id, questionAnswers(request.questions.length, selections, others));
  };

  return (
    <Card>
      <Card.Header>
        <Card.Title>The agent asks</Card.Title>
      </Card.Header>
      <Card.Body style={{ gap: 16 }}>
        {request.questions.map((question, index) => (
          <View key={index} style={{ gap: 8 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Chip size="sm" variant="soft">
                {question.header}
              </Chip>
              <Text className="text-foreground" style={{ flex: 1, fontSize: 15 }}>
                {question.question}
              </Text>
            </View>
            {question.multiSelect === true ? (
              <View style={{ gap: 6 }}>
                {question.options.map((option) => {
                  const selected = (selections[index] ?? []).includes(option.label);
                  return (
                    <View key={option.label} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                      <Checkbox
                        isSelected={selected}
                        onSelectedChange={(isSelected) =>
                          setSelection(
                            index,
                            isSelected
                              ? [...(selections[index] ?? []), option.label]
                              : (selections[index] ?? []).filter((each) => each !== option.label),
                          )
                        }
                      />
                      <View style={{ flex: 1 }}>
                        <Text className="text-foreground" style={{ fontSize: 15 }}>
                          {option.label}
                        </Text>
                        {option.description === undefined ? null : (
                          <Text className="text-muted" style={{ fontSize: 13 }}>
                            {option.description}
                          </Text>
                        )}
                      </View>
                    </View>
                  );
                })}
              </View>
            ) : (
              <RadioGroup value={selections[index]?.[0] ?? ""} onValueChange={(value) => setSelection(index, [value])}>
                {question.options.map((option) => (
                  <RadioGroup.Item key={option.label} value={option.label}>
                    <View style={{ flex: 1 }}>
                      <Text className="text-foreground" style={{ fontSize: 15 }}>
                        {option.label}
                      </Text>
                      {option.description === undefined ? null : (
                        <Text className="text-muted" style={{ fontSize: 13 }}>
                          {option.description}
                        </Text>
                      )}
                    </View>
                    <Radio />
                  </RadioGroup.Item>
                ))}
              </RadioGroup>
            )}
            <TextInput
              className="bg-surface-tertiary text-foreground"
              style={{ borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, fontSize: 16 }}
              placeholder="Other…"
              placeholderTextColor={fieldPlaceholder}
              value={others[index] ?? ""}
              onChangeText={(value) => setOther(index, value)}
            />
          </View>
        ))}
      </Card.Body>
      <Card.Footer>
        <Button onPress={submit} isDisabled={!connected}>
          Submit
        </Button>
      </Card.Footer>
    </Card>
  );
}

export function PendingQuestions({
  docs,
  remote,
  connected,
}: {
  docs: readonly ExtensionDocView[];
  remote: RemoteDurable;
  connected: boolean;
}) {
  const pending = pendingQuestions(docs);
  const { height } = useWindowDimensions();
  if (pending.length === 0) return null;
  return (
    // Capped so a long question set never pushes the composer off screen.
    <ScrollView
      style={{ maxHeight: height * 0.45 }}
      contentContainerStyle={{ gap: 8, paddingHorizontal: 12, paddingBottom: 4 }}
    >
      {pending.map(({ kind, request }) => (
        <QuestionCard key={request.id} kind={kind} request={request} remote={remote} connected={connected} />
      ))}
    </ScrollView>
  );
}
