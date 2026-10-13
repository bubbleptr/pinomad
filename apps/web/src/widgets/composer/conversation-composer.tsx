import { Button } from "@astryxdesign/core/Button";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { Text } from "@astryxdesign/core/Text";
import { Thumbnail } from "@astryxdesign/core/Thumbnail";
import { useRef, useState } from "react";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import type { DurableView } from "@pinomad/protocol/view.ts";
import { ComposerLocationRow, ComposerStaticChip } from "../../entities/checkout/composer-location-row.tsx";
import { requestNotificationPermission } from "../../entities/conversation/notification-permission.ts";
import { imageSrc } from "../../entities/image/message-images.tsx";
import { useImageAttachments } from "../../entities/image/use-image-attachments.ts";
import { ModelSelector } from "../../entities/model/model-selector.tsx";
import { agentOf, queueItems, statusText } from "@pinomad/client/chat.ts";
import { summaryOf } from "@pinomad/client/model.ts";
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

  const accepts = summaryOf(view.models, agent.model)?.images === true;
  const { images, pending, error, add, remove, clear } = useImageAttachments(accepts);
  const fileInput = useRef<HTMLInputElement>(null);

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
      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        multiple
        hidden
        aria-hidden
        tabIndex={-1}
        onChange={(event) => {
          add([...(event.target.files ?? [])]);
          // Picking the same file twice must fire again.
          event.target.value = "";
        }}
      />
      <ChatPromptInput
        value={value}
        status={busy ? "streaming" : "ready"}
        isDisabled={disconnected}
        placeholder={busy ? "Steer the running turn…" : "Ask the agent…"}
        onValueChange={setValue}
        onSubmit={() => submit("steer")}
        onStop={busy ? () => void remote.controller.abort() : undefined}
        attachments={
          images.length === 0 && !pending ? undefined : (
            <div className="flex flex-wrap gap-2" data-testid="composer-attachments">
              {images.map((image, index) => (
                <Thumbnail
                  key={index}
                  src={imageSrc(image)}
                  alt={`Image ${index + 1}`}
                  onRemove={() => remove(index)}
                />
              ))}
              {pending ? <Thumbnail isLoading alt="Preparing image" /> : null}
            </div>
          )
        }
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
                  label: "Add images…",
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
        footer={<ComposerLocationRow location={location} branch={branch} />}
      />
    </>
  );
}
