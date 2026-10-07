// ADR-0005: extension documents render through `classify` — typed views for
// conforming values, a key-value fallback for everything else so an unknown or
// malformed document is still inspectable.
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { Text } from "@astryxdesign/core/Text";
import { Token } from "@astryxdesign/core/Token";
import type { JsonValue } from "@earendil-works/chord";
import { classify, type QuestionRequest, type QuestionState } from "@pinomad/protocol/presentation.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import type { ExtensionDocView } from "@pinomad/protocol/view.ts";

const STATUS_LABEL = { pending: "pending", in_progress: "in progress", completed: "completed" } as const;

export function DocumentView({ doc }: { doc: ExtensionDocView; remote: RemoteDurable; connected: boolean }) {
  if (doc.value === null) return null;
  const classified = classify(doc.presentation, doc.value);
  // A classified doc gets a product name; the fallback keeps the kind for inspection.
  const heading = classified.type === "pinomad.todo" ? "Todo" : classified.type === "pinomad.question" ? "Questions" : doc.kind;
  const content =
    classified.type === "pinomad.todo" ? (
      <TodoDoc doc={classified.value} />
    ) : classified.type === "pinomad.question" ? (
      <QuestionDoc doc={classified.value} />
    ) : (
      <FallbackDoc value={classified.value} />
    );
  return (
    <VStack gap={1}>
      <Text type="label" weight="semibold">{heading}</Text>
      {content}
    </VStack>
  );
}

function TodoDoc({ doc }: { doc: { items: readonly { text: string; status: "pending" | "in_progress" | "completed" }[] } }) {
  return (
    <List density="compact">
      {doc.items.length === 0 ? (
        <ListItem label="Empty" />
      ) : (
        doc.items.map((item, index) => (
          <ListItem key={index} label={item.text} startContent={<Token label={STATUS_LABEL[item.status]} size="sm" />} />
        ))
      )}
    </List>
  );
}

/** One row per question; pending requests answer above the composer instead. */
function statusOf(request: QuestionRequest, index: number): { label: string; color?: "green" | "gray" } {
  const resolution = request.resolution;
  if (resolution === undefined) return { label: "pending" };
  if (resolution.outcome === "dismissed") return { label: "answered in chat", color: "gray" };
  if (resolution.outcome === "cancelled") return { label: "cancelled", color: "gray" };
  const answer = resolution.answers[index];
  if (answer === undefined || (answer.selected.length === 0 && answer.other === undefined)) return { label: "skipped", color: "gray" };
  const text = [answer.selected.join(", "), ...(answer.other === undefined ? [] : [`other: "${answer.other}"`])]
    .filter((part) => part !== "")
    .join("; ");
  return { label: text === "" ? "skipped" : text, color: "green" };
}

function QuestionDoc({ doc }: { doc: QuestionState }) {
  return (
    <List density="compact">
      {doc.requests.length === 0 ? (
        <ListItem label="Empty" />
      ) : (
        doc.requests.flatMap((request) =>
          request.questions.map((question, index) => {
            const status = statusOf(request, index);
            return (
              <ListItem
                key={`${request.id}-${index}`}
                label={question.question}
                description={status.label}
                startContent={<Token label={question.header} size="sm" />}
              />
            );
          }),
        )
      )}
    </List>
  );
}

/** One row per top-level key; scalar roots get a single row. */
function FallbackDoc({ value }: { value: unknown }) {
  const entries: [string, unknown][] =
    typeof value === "object" && value !== null && !Array.isArray(value) ? Object.entries(value) : [["value", value]];
  return (
    <List density="compact">
      {entries.map(([key, entry]) => (
        <ListItem key={key} label={key} description={compact(entry)} />
      ))}
    </List>
  );
}

function compact(value: JsonValue | unknown): string {
  const json = JSON.stringify(value);
  return json.length <= 120 ? json : `${json.slice(0, 117)}...`;
}
