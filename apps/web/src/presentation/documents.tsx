// ADR-0005: extension documents render through `classify` — typed views for
// conforming values, a key-value fallback for everything else so an unknown or
// malformed document is still inspectable.
import { Button } from "@astryxdesign/core/Button";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { Text } from "@astryxdesign/core/Text";
import { Token } from "@astryxdesign/core/Token";
import type { JsonValue } from "@earendil-works/chord";
import { classify } from "@pinomad/protocol/presentation.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import type { ExtensionDocView } from "@pinomad/protocol/view.ts";

const STATUS_LABEL = { pending: "pending", in_progress: "in progress", completed: "completed" } as const;

export function DocumentView({ doc, remote, connected }: { doc: ExtensionDocView; remote: RemoteDurable; connected: boolean }) {
  if (doc.value === null) return null;
  const classified = classify(doc.presentation, doc.value);
  // A classified doc gets a product name; the fallback keeps the kind for inspection.
  const heading = classified.type === "pinomad.todo" ? "Todo" : classified.type === "pinomad.approval" ? "Approvals" : doc.kind;
  const content =
    classified.type === "pinomad.todo" ? (
      <TodoDoc doc={classified.value} />
    ) : classified.type === "pinomad.approval" ? (
      <ApprovalDoc kind={doc.kind} doc={classified.value} remote={remote} connected={connected} />
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

function ApprovalDoc({
  kind,
  doc,
  remote,
  connected,
}: {
  kind: string;
  doc: {
    requests: readonly {
      id: string;
      title: string;
      detail?: string;
      requestedAt: number;
      decision?: { outcome: "approved" | "rejected" | "cancelled"; at: number };
    }[];
  };
  remote: RemoteDurable;
  connected: boolean;
}) {
  return (
    <List density="compact">
      {doc.requests.length === 0 ? (
        <ListItem label="Empty" />
      ) : (
        doc.requests.map((request) => (
          <ListItem
            key={request.id}
            label={request.title}
            {...(request.detail === undefined ? {} : { description: request.detail })}
            endContent={
              request.decision === undefined ? (
                <HStack gap={1}>
                  <Button
                    label="Approve"
                    variant="secondary"
                    size="sm"
                    isDisabled={!connected}
                    onClick={() => void remote.controller.decide(kind, request.id, true)}
                  />
                  <Button
                    label="Reject"
                    variant="ghost"
                    size="sm"
                    isDisabled={!connected}
                    onClick={() => void remote.controller.decide(kind, request.id, false)}
                  />
                </HStack>
              ) : (
                <Token
                  label={request.decision.outcome}
                  color={request.decision.outcome === "approved" ? "green" : request.decision.outcome === "rejected" ? "red" : "gray"}
                  size="sm"
                />
              )
            }
          />
        ))
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
