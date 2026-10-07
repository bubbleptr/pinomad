// The `pinomad.codemode` card detail (ADR-0013 §7): the script (folded), the
// nested calls it made with status and duration, and the text/images the script
// produced for the model. Nested calls with a `pinomad.diff` details payload
// expand into the same DiffView a direct call would show.
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Markdown } from "@astryxdesign/core/Markdown";
import { Text } from "@astryxdesign/core/Text";
import { Token } from "@astryxdesign/core/Token";
import type { CodemodeCall, CodemodeDetails } from "@pinomad/protocol/presentation.ts";
import { classify } from "@pinomad/protocol/presentation.ts";
import type { DurableView } from "@pinomad/protocol/view.ts";
import { DiffView } from "./diff.tsx";
import type { ToolCallView } from "./chat.ts";

const STATUS_COLOR = { running: "blue", ok: "green", error: "red", cancelled: "orange" } as const;

function CallRow({
  call,
  running,
  toolPresentations,
}: {
  call: CodemodeCall;
  running: boolean;
  toolPresentations: DurableView["toolPresentations"];
}) {
  // The stored details freeze at the last committed publish: a call aborted
  // mid-flight keeps `running` forever, so a finished card renders it cancelled.
  const status = call.status === "running" && !running ? "cancelled" : call.status;
  const classified = call.details === undefined ? undefined : classify(toolPresentations[call.name], call.details);
  const body = (
    <VStack gap={1}>
      <HStack gap={2} vAlign="center">
        <Token label={status} size="sm" color={STATUS_COLOR[status]} />
        <Text type="code">{call.name}</Text>
        {call.durationMs === undefined ? null : <Text type="supporting">{(call.durationMs / 1000).toFixed(1)}s</Text>}
      </HStack>
      <Text type="supporting" maxLines={2}>
        {call.args}
      </Text>
      {call.error === undefined ? null : (
        <Text type="supporting" style={{ color: "var(--color-text-red)" }} maxLines={4}>
          {call.error}
        </Text>
      )}
    </VStack>
  );
  // Rows whose nested call carried a declared presentation expand to it.
  return classified?.type === "pinomad.diff" ? (
    <Collapsible trigger={body} defaultIsOpen={false}>
      <DiffView patch={classified.value.patch} />
    </Collapsible>
  ) : (
    body
  );
}

export function CodemodeView({
  details,
  tool,
  toolPresentations,
}: {
  details: CodemodeDetails;
  tool: ToolCallView;
  toolPresentations: DurableView["toolPresentations"];
}) {
  const running = tool.status === "running";
  return (
    <VStack gap={2}>
      <Collapsible trigger={<Text type="supporting">Script</Text>} defaultIsOpen={false}>
        <Markdown density="compact">{`\`\`\`js\n${details.code}\n\`\`\``}</Markdown>
      </Collapsible>
      {details.calls.length === 0 ? null : (
        <VStack gap={3}>
          {details.calls.map((call, index) => (
            <CallRow key={index} call={call} running={running} toolPresentations={toolPresentations} />
          ))}
        </VStack>
      )}
      {/* On error the same text already shows as the card's error row. */}
      {tool.status === "error" || tool.output === undefined || tool.output === "" ? null : (
        <Markdown density="compact">{`\`\`\`\n${tool.output}\n\`\`\``}</Markdown>
      )}
      {(tool.images ?? []).map((image, index) => (
        <img key={index} src={`data:${image.mimeType};base64,${image.data}`} alt="" style={{ maxWidth: "100%" }} />
      ))}
    </VStack>
  );
}
