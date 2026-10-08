import { Button } from "@astryxdesign/core/Button";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { Text } from "@astryxdesign/core/Text";
import { useState } from "react";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import type { DurableView } from "@pinomad/protocol/view.ts";
import { ComposerLocationRow, ComposerStaticChip } from "../../entities/checkout/composer-location-row.tsx";
import { ModelSelector } from "../../entities/model/model-selector.tsx";
import { agentOf, queueItems, statusText } from "../../presentation/chat.ts";
import { ChatPromptInput } from "../../shared/ui/chat/chat-prompt-input.tsx";
import { ChatAdd, Computer, FolderLibrary, GitBranch, Plus } from "../../shared/ui/icons";
import { QueuedList } from "./queued-list.tsx";

/**
 * The live conversation's composer, Pace-composed: status line, queued
 * messages, then the prompt input with the + menu and the model · thinking
 * capsule on the left, Follow-up next to send while busy, and the location
 * row in the footer.
 */
export function ConversationComposer({
  view,
  remote,
  conversation,
  busy,
  narrow,
}: {
  view: DurableView;
  remote: RemoteDurable;
  conversation: NonNullable<DurableView["conversation"]>;
  busy: boolean;
  narrow: boolean;
}) {
  const [value, setValue] = useState("");
  const agent = agentOf(conversation);
  const status = statusText(conversation);
  const disconnected = view.connection !== "connected";
  const queue = queueItems(conversation);
  const checkout = view.checkout;
  const isProject = view.home?.kind === "project";

  const location = isProject ? (
    checkout !== undefined ? (
      <ComposerStaticChip chrome="selector" icon={FolderLibrary} label="Git worktree" testId="composer-location-label" />
    ) : (
      <ComposerStaticChip chrome="selector" icon={Computer} label="Project folder" testId="composer-location-label" />
    )
  ) : (
    <ComposerStaticChip chrome="selector" icon={ChatAdd} label="Chat" testId="composer-location-label" />
  );
  const branch =
    checkout === undefined ? null : (
      <ComposerStaticChip chrome="button" icon={GitBranch} label={checkout.branch} testId="composer-branch-label" />
    );

  const submit = (whenBusy: "steer" | "followUp"): void => {
    const text = value.trim();
    if (text === "") return;
    void remote.controller.submit(text, whenBusy);
    setValue("");
  };

  return (
    <>
      {status === "" ? null : <Text type="supporting">{status}</Text>}
      <QueuedList items={queue} />
      <ChatPromptInput
        value={value}
        status={busy ? "streaming" : "ready"}
        isDisabled={disconnected}
        placeholder={busy ? "Steer the running turn…" : "Ask the agent…"}
        onValueChange={setValue}
        onSubmit={() => submit("steer")}
        onStop={busy ? () => void remote.controller.abort() : undefined}
        startActions={
          <>
            <DropdownMenu
              button={{
                label: "More actions",
                variant: "ghost",
                size: "sm",
                isIconOnly: true,
                icon: <Plus aria-hidden="true" />,
                isDisabled: disconnected,
              }}
              items={[{ label: "Compact conversation", isDisabled: disconnected, onClick: () => void remote.controller.compact(undefined) }]}
            />
            <ModelSelector
              models={view.models}
              selected={{ model: agent.model, level: agent.thinkingLevel ?? "off" }}
              isDisabled={disconnected}
              onModelChange={(model) => void remote.controller.setModel(model)}
              onLevelChange={(level) => void remote.controller.setThinkingLevel(level)}
            />
          </>
        }
        endActions={
          busy && value.trim() !== "" ? (
            <Button
              label="Follow-up"
              variant="ghost"
              size={narrow ? "md" : "sm"}
              tooltip="Queue after the running turn"
              onClick={() => submit("followUp")}
            />
          ) : null
        }
        footer={<ComposerLocationRow location={location} branch={branch} />}
      />
    </>
  );
}
