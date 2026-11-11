import type { JsonValue } from "@earendil-works/chord";
import { classify, type QuestionRequest, type QuestionState } from "@pinomad/protocol/presentation.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import type { ExtensionDocView } from "@pinomad/protocol/view.ts";
import { Badge } from "../shared/ui/badge.tsx";
import { Item, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from "../shared/ui/item.tsx";

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
    <div className="flex flex-col gap-1">
      <span className="text-sm/5 font-semibold">{heading}</span>
      {content}
    </div>
  );
}

function TodoDoc({ doc }: { doc: { items: readonly { text: string; status: "pending" | "in_progress" | "completed" }[] } }) {
  return (
    <ItemGroup>
      {doc.items.length === 0 ? (
        <EmptyRow />
      ) : (
        doc.items.map((item, index) => (
          <Item key={index} size="sm" render={<li />}>
            <ItemMedia>
              <Badge>{STATUS_LABEL[item.status]}</Badge>
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{item.text}</ItemTitle>
            </ItemContent>
          </Item>
        ))
      )}
    </ItemGroup>
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
    <ItemGroup>
      {doc.requests.length === 0 ? (
        <EmptyRow />
      ) : (
        doc.requests.flatMap((request) =>
          request.questions.map((question, index) => {
            const status = statusOf(request, index);
            return (
              <Item key={`${request.id}-${index}`} size="sm" render={<li />}>
                <ItemMedia>
                  <Badge>{question.header}</Badge>
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{question.question}</ItemTitle>
                  <ItemDescription>{status.label}</ItemDescription>
                </ItemContent>
              </Item>
            );
          }),
        )
      )}
    </ItemGroup>
  );
}

/** One row per top-level key; scalar roots get a single row. */
function FallbackDoc({ value }: { value: unknown }) {
  const entries: [string, unknown][] =
    typeof value === "object" && value !== null && !Array.isArray(value) ? Object.entries(value) : [["value", value]];
  return (
    <ItemGroup>
      {entries.map(([key, entry]) => (
        <Item key={key} size="sm" render={<li />}>
          <ItemContent>
            <ItemTitle>{key}</ItemTitle>
            <ItemDescription>{compact(entry)}</ItemDescription>
          </ItemContent>
        </Item>
      ))}
    </ItemGroup>
  );
}

function EmptyRow() {
  return (
    <Item size="sm" render={<li />}>
      <ItemContent>
        <ItemTitle>Empty</ItemTitle>
      </ItemContent>
    </Item>
  );
}

function compact(value: JsonValue | unknown): string {
  const json = JSON.stringify(value);
  return json.length <= 120 ? json : `${json.slice(0, 117)}...`;
}
