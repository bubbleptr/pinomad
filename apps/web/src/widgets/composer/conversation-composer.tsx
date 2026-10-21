import { Button } from "@astryxdesign/core/Button";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { Text } from "@astryxdesign/core/Text";
import { useRef, useState } from "react";
import { hostSupportsCall } from "@pinomad/protocol/frames.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import type { DurableView } from "@pinomad/protocol/view.ts";
import { requestNotificationPermission } from "../../entities/conversation/notification-permission.ts";
import { useAtMentions } from "../../entities/agent/agent-mentions.tsx";
import { useSkillHighlight, useSkillMentions } from "../../entities/agent/skill-mentions.tsx";
import { attachmentDrawer, ImageFileInput } from "../../entities/image/attachments.tsx";
import { useImageAttachments } from "../../entities/image/use-image-attachments.ts";
import { ModelSelector } from "../../entities/model/model-selector.tsx";
import { agentOf, queueItems, statusText } from "@pinomad/client/chat.ts";
import { summaryOf } from "@pinomad/client/model.ts";
import { ChatPromptInput, type ChatPromptInputHandle } from "../../shared/ui/chat/chat-prompt-input.tsx";
import { Plus } from "../../shared/ui/icons";
import { QueuedList } from "./queued-list.tsx";

/**
 * The live conversation's composer, Pace-composed: status line, queued
 * messages, then the prompt input with the + menu and the model · thinking
 * capsule on the left and Follow-up next to send while busy. Where it runs
 * and how full its context is live in the overview card, not under it.
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
  const inputRef = useRef<ChatPromptInputHandle | null>(null);
  const atMentions = useAtMentions(
    view.agents,
    inputRef,
    // A Chat conversation has no project files; like a Chat draft, it offers agents only.
    view.home?.kind !== "chat" && hostSupportsCall(view.host?.protocol.minor ?? 0, "listFiles")
      ? {
          key: `conversation:${conversation.conversation.id}`,
          list: (query) =>
            remote.controller.listFiles(
              { kind: "conversation", conversationId: conversation.conversation.id },
              query,
            ),
        }
      : undefined,
  );
  // `$` skill mentions (issue #143): the conversation's own scope — a Chat
  // conversation still lists the user's skills.
  const skills = useSkillMentions(
    remote,
    { kind: "conversation", conversationId: conversation.conversation.id },
    inputRef,
    !disconnected && hostSupportsCall(view.host?.protocol.minor ?? 0, "listSkills"),
  );
  useSkillHighlight(inputRef, value, skills.names);
  const triggers = [...(atMentions ?? []), ...(skills.trigger === undefined ? [] : [skills.trigger])];
  const queue = queueItems(conversation);

  const model = summaryOf(view.models, agent.model);
  const accepts = model?.images === true;
  const { images, pending, error, add, remove, clear } = useImageAttachments(accepts);
  const fileInput = useRef<HTMLInputElement>(null);
  // No "why" slot on menu items: the reason goes into the label itself.
  const addImages =
    accepts || disconnected
      ? "Add images…"
      : `Add images… (${model?.name ?? agent.model?.modelId ?? "This model"} can't see images)`;

  const submit = (whenBusy: "steer" | "followUp"): void => {
    const text = value.trim();
    if ((text === "" && images.length === 0) || pending) return;
    requestNotificationPermission();
    void remote.controller.submit(text, whenBusy, { images });
    setValue("");
    clear();
  };

  return (
    <>
      {status === "" ? null : <Text type="supporting">{status}</Text>}
      <QueuedList items={queue} />
      <ImageFileInput inputRef={fileInput} onFiles={add} />
      <ChatPromptInput
        value={value}
        inputRef={inputRef}
        status={busy ? "streaming" : "ready"}
        isDisabled={disconnected}
        placeholder={busy ? "Steer the running turn…" : "Ask the agent…"}
        onValueChange={setValue}
        onSubmit={() => submit("steer")}
        onFocus={skills.request}
        triggers={triggers.length === 0 ? undefined : triggers}
        onStop={busy ? () => void remote.controller.abort() : undefined}
        attachments={attachmentDrawer({ images, pending, onRemove: remove })}
        hasAttachments={images.length > 0}
        onFiles={add}
        error={error}
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
              items={[
                {
                  label: addImages,
                  isDisabled: disconnected || !accepts,
                  onClick: () => fileInput.current?.click(),
                },
                { label: "Compact conversation", isDisabled: disconnected, onClick: () => void remote.controller.compact(undefined) },
              ]}
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
          busy && (value.trim() !== "" || images.length > 0) ? (
            <Button
              label="Follow-up"
              variant="ghost"
              size={narrow ? "md" : "sm"}
              tooltip="Queue after the running turn"
              isDisabled={disconnected || pending}
              onClick={() => submit("followUp")}
            />
          ) : null
        }
      />
    </>
  );
}
