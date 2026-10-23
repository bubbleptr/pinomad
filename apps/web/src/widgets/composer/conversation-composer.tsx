import { Button } from "@astryxdesign/core/Button";
import { DropdownMenuItem, DropdownMenuSubMenu } from "@astryxdesign/core/DropdownMenu";
import { Text } from "@astryxdesign/core/Text";
import { useToast } from "@astryxdesign/core/Toast";
import { useEffect, useRef, useState } from "react";
import { hostSupportsCall } from "@pinomad/protocol/frames.ts";
import type { MessageImage, ViewImage } from "@pinomad/protocol/images.ts";
import { findConversation } from "@pinomad/protocol/organization.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import type { DurableView } from "@pinomad/protocol/view.ts";
import { requestNotificationPermission } from "../../entities/conversation/notification-permission.ts";
import { useAtMentions, type MentionFiles } from "../../entities/agent/agent-mentions.tsx";
import { useSkillDraft, useSkillHighlight, useSkillMentions } from "../../entities/agent/skill-mentions.tsx";
import { draftMessage } from "../../entities/agent/skill-bindings.ts";
import { useSlashCommands } from "../../entities/command/slash-commands.tsx";
import { attachmentDrawer, ImageFileInput } from "../../entities/image/attachments.tsx";
import { loadImageBytes, primeImages } from "../../entities/image/image-cache.ts";
import { useImageAttachments } from "../../entities/image/use-image-attachments.ts";
import { ModelSelector } from "../../entities/model/model-selector.tsx";
import { agentOf, queueItems, queuedInput, statusText, type QueueItem } from "@pinomad/client/chat.ts";
import { parseCommandInput } from "@pinomad/client/command-input.ts";
import { summaryOf } from "@pinomad/client/model.ts";
import { ChatAddMenu, ChatAddMenuSection } from "../../shared/ui/chat/chat-add-menu.tsx";
import { ChatPromptInput, type ChatPromptInputHandle } from "../../shared/ui/chat/chat-prompt-input.tsx";
import { composerPlaceholder } from "../../shared/ui/chat/chat-placeholder.ts";
import { QueuedList } from "./queued-list.tsx";

/** A queued edit's images as bytes, or undefined when any one cannot load. */
async function resolveImages(
  images: readonly ViewImage[],
  load: (ref: string) => Promise<MessageImage>,
): Promise<MessageImage[] | undefined> {
  try {
    return await Promise.all(images.map((image) => loadImageBytes(image, load)));
  } catch {
    return undefined;
  }
}

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
  // A plain string plus the `$` picks bound in it (ADR-0028).
  const skillDraft = useSkillDraft();
  const { value, setValue } = skillDraft;
  const [focusAfterEdit, setFocusAfterEdit] = useState(0);
  const [awaitingEdit, setAwaitingEdit] = useState(false);
  // The render-time value can lag the controller: #lost rejects in-flight calls
  // before React hears about the disconnect. Refresh from the live source in
  // the catch rather than trusting this ref's last render.
  const connectionRef = useRef(view.connection);
  connectionRef.current = view.connection;
  const toast = useToast();
  const agent = agentOf(conversation);
  const status = statusText(conversation);
  const disconnected = view.connection !== "connected";
  const inputRef = useRef<ChatPromptInputHandle | null>(null);
  // A Chat conversation has no project files; like a Chat draft, it offers
  // agents only — and its + menu no "Mention a file…".
  const fileSource: MentionFiles | undefined =
    view.home?.kind !== "chat" && hostSupportsCall(view.host?.protocol.minor ?? 0, "listFiles")
      ? {
          key: `conversation:${conversation.conversation.id}`,
          list: (query) =>
            remote.controller.listFiles(
              { kind: "conversation", conversationId: conversation.conversation.id },
              query,
            ),
        }
      : undefined;
  const atMentions = useAtMentions(view.agents, inputRef, fileSource);
  // `$` skill mentions (issue #143): the conversation's own scope — a Chat
  // conversation still lists the user's skills.
  const skills = useSkillMentions(
    remote,
    { kind: "conversation", conversationId: conversation.conversation.id },
    inputRef,
    !disconnected && hostSupportsCall(view.host?.protocol.minor ?? 0, "listSkills"),
    skillDraft.pick,
  );
  useSkillHighlight(inputRef, skillDraft.draft);
  // `/` commands (ADR-0027) need a 5.15 host; an older one keeps the + menu's
  // Compact conversation and shows no `/` menu.
  const listsCommands = hostSupportsCall(view.host?.protocol.minor ?? 0, "listCommands");
  const slash = useSlashCommands(remote, conversation.conversation.id, inputRef, !disconnected && listsCommands, value);
  const triggers = [
    ...(atMentions ?? []),
    ...(skills.trigger === undefined ? [] : [skills.trigger]),
    ...(slash.trigger === undefined ? [] : [slash.trigger]),
  ];
  const queue = queueItems(conversation);
  const roles = view.agents?.roles ?? [];
  // The role the conversation was created with — fixed for its life (ADR-0023).
  const role = findConversation(view.organized, conversation.conversation.id)?.summary.role;

  const model = summaryOf(view.models, agent.model);
  const accepts = model?.images === true;
  const { images, pending: imagesPending, error, add, restore, remove, clear } = useImageAttachments(accepts);
  // Why a typed command wasn't run; any edit to the draft clears it.
  const [commandError, setCommandError] = useState<string | undefined>(undefined);
  useEffect(() => setCommandError(undefined), [value, images.length]);
  // Why the + menu's Commands row can't open: a command starts at index 0, so
  // picking one into a draft with a message would bury or replace it.
  const commandsUnavailable =
    slash.commands === undefined
      ? "Loading…"
      : slash.commands.length === 0
        ? "None on this host"
        : value.trim() !== "" || images.length > 0 || imagesPending
          ? "Clear the message first"
          : undefined;
  const fileInput = useRef<HTMLInputElement>(null);
  // No "why" slot on menu items: the reason goes into the label itself.
  const addImages =
    accepts || disconnected
      ? "Add images…"
      : `Add images… (${model?.name ?? agent.model?.modelId ?? "This model"} can't see images)`;

  // Queued-input calls are requests, not commands: their outcomes and errors
  // come back here instead of becoming host notices. One request per row at a
  // time; the ref makes a double click before the next render a no-op too.
  type PendingAction = { id: number; kind: "steer" | "withdraw" | "edit" };
  const [pendingActions, setPendingActions] = useState<readonly PendingAction[]>([]);
  const pendingRows = useRef(new Set<number>());
  const beginAction = (id: number, kind: PendingAction["kind"]): boolean => {
    if (pendingRows.current.has(id)) return false;
    pendingRows.current.add(id);
    setPendingActions((current) => [...current, { id, kind }]);
    return true;
  };
  const endAction = (id: number): void => {
    pendingRows.current.delete(id);
    setPendingActions((current) => current.filter((action) => action.id !== id));
  };
  const pendingIds = new Set(pendingActions.map((action) => action.id));
  const editInFlight = pendingActions.some((action) => action.kind === "edit");
  // Restoring a withdrawn row overwrites the composer, so the draft must be
  // empty first; while one Edit is in flight no other row may start one.
  const composerOccupied = value.trim() !== "" || images.length > 0 || imagesPending;
  const editDisabled = composerOccupied || editInFlight || awaitingEdit;
  const editTooltip = composerOccupied ? "Clear the composer to edit" : undefined;
  // While Edit is in flight, or its withdraw outcome is unknown after an
  // error, the composer and every attachment entry stay locked: a later
  // refill must not overwrite something the user wrote in the meantime.
  const editLocked = editInFlight || awaitingEdit;
  const canAct = !disconnected && hostSupportsCall(view.host?.protocol.minor ?? 0, "withdrawQueued");
  const conversationId = conversation.conversation.id;
  const showError = (error: unknown): void => {
    toast({ body: error instanceof Error ? error.message : String(error), type: "error" });
  };
  const withdraw = async (item: QueueItem): Promise<void> => {
    if (!beginAction(item.id, "withdraw")) return;
    try {
      if ((await remote.controller.withdrawQueued(item.id, conversationId)) === "sent") {
        toast({ body: "Already sent — can't withdraw" });
      }
    } catch (error) {
      showError(error);
    } finally {
      endAction(item.id);
    }
  };
  const steer = async (item: QueueItem): Promise<void> => {
    if (!beginAction(item.id, "steer")) return;
    try {
      // "sent"/"unavailable" have nothing to say: the message is already out,
      // or someone else settled it before the promotion landed.
      await remote.controller.steerQueued(item.id, conversationId);
    } catch (error) {
      showError(error);
    } finally {
      endAction(item.id);
    }
  };
  // The original content is snapshotted before withdrawing so a lost reply
  // can be resolved again after reconnect; once withdrawn, only a filled
  // composer and a focused input remain.
  type EditCopy = {
    conversationId: typeof conversationId;
    id: number;
    input: NonNullable<ReturnType<typeof queuedInput>>;
  };
  const editCopy = useRef<EditCopy | null>(null);
  const resolveEdit = async (copy: EditCopy): Promise<void> => {
    if (!beginAction(copy.id, "edit")) return;
    try {
      const resolved = await resolveImages(copy.input.images, (ref) => remote.controller.image(ref));
      if (resolved === undefined) {
        // Withdrawing without every original would lose an attachment; leave
        // the queued message where it is and let the user try again.
        editCopy.current = null;
        setAwaitingEdit(false);
        toast({ body: "Couldn't load the original images — try again", type: "error" });
        return;
      }
      // Restored bytes are about to become sendable; reserve their refs now,
      // before the composer unlocks, so the next send needs no async barrier.
      await primeImages(resolved);
      // The copy survives a lost withdraw reply by bytes alone, so a reconnect
      // retry needs no refs (which may have left the host's live view since).
      copy.input = { ...copy.input, images: resolved };
      if ((await remote.controller.withdrawQueued(copy.id, copy.conversationId)) === "withdrawn") {
        // The skills it expanded come back bound.
        skillDraft.restore(copy.input.text, copy.input.skills);
        restore(resolved);
        editCopy.current = null;
        setAwaitingEdit(false);
        setFocusAfterEdit((count) => count + 1);
      } else {
        editCopy.current = null;
        setAwaitingEdit(false);
        toast({ body: "Already sent — can't withdraw" });
      }
    } catch (error) {
      showError(error);
      connectionRef.current = remote.view.current().connection;
      if (connectionRef.current === "connected") {
        // The host rejected the call while the connection stayed up, so the
        // message was not withdrawn. Drop the copy and unlock; the row, if it
        // is still queued, can be edited again.
        editCopy.current = null;
        setAwaitingEdit(false);
      } else {
        // The row may already be gone; keep the copy for the reconnect retry.
        setAwaitingEdit(true);
      }
    } finally {
      endAction(copy.id);
    }
  };
  const edit = async (item: QueueItem): Promise<void> => {
    const retained =
      editCopy.current?.id === item.id && editCopy.current.conversationId === conversationId
        ? editCopy.current.input
        : undefined;
    const input = retained ?? queuedInput(conversation, item.id);
    if (input === undefined) return;
    const copy = { conversationId, id: item.id, input };
    editCopy.current = copy;
    await resolveEdit(copy);
  };
  // A dropped withdraw response leaves the outcome unknown, and the row may
  // already be gone. Reconnect is the retry trigger: ask by id again, even
  // without a row, because the host's withdraw is idempotent.
  useEffect(() => {
    if (view.connection !== "connected" || !awaitingEdit) return;
    const copy = editCopy.current;
    if (copy === null || copy.conversationId !== conversationId) return;
    if (pendingRows.current.has(copy.id)) return;
    void resolveEdit(copy);
  }, [view.connection, awaitingEdit, conversationId]);
  // The editable is disabled while Edit is in flight, so focus waits for the
  // render that re-enables it rather than racing the still-disabled element.
  useEffect(() => {
    if (focusAfterEdit > 0) inputRef.current?.focusAtEnd();
  }, [focusAfterEdit]);

  const submit = (whenBusy: "steer" | "followUp"): void => {
    // Only the picked skills go out as `skills` (ADR-0028).
    const message = draftMessage(skillDraft.draft);
    const text = message.text.trim();
    if (editLocked || (text === "" && images.length === 0) || imagesPending) return;
    // A command runs at once — never steered or queued, never a message. The
    // raw draft is parsed (leading whitespace makes it a message), and only
    // once the host's list has loaded: before that, text is never a command.
    const command = slash.commands === undefined ? undefined : parseCommandInput(message.text, slash.commands);
    if (command !== undefined) {
      const disabled = slash.commands?.find((each) => each.name === command.name)?.disabled;
      if (disabled !== undefined) {
        setCommandError(disabled);
        return;
      }
      if (images.length > 0) {
        setCommandError("Commands can't include images");
        return;
      }
      void remote.controller.runCommand(command.name, command.args);
      setValue("");
      return;
    }
    requestNotificationPermission();
    const sending = images;
    // Staged images were primed before they became sendable. Queue the send
    // synchronously: an await here could let a conversation switch or a later
    // message overtake it inside the controller's ordered command queue.
    void remote.controller.submit(text, whenBusy, { images: sending, skills: message.skills });
    setValue("");
    clear();
  };

  return (
    <>
      {status === "" ? null : <Text type="supporting">{status}</Text>}
      <QueuedList
        items={queue}
        canAct={canAct}
        busy={busy}
        editDisabled={editDisabled}
        editTooltip={editTooltip}
        editRetryId={awaitingEdit ? editCopy.current?.id : undefined}
        narrow={narrow}
        pendingIds={pendingIds}
        onSteer={(item) => void steer(item)}
        onEdit={(item) => void edit(item)}
        onWithdraw={(item) => void withdraw(item)}
      />
      <ImageFileInput inputRef={fileInput} onFiles={editLocked ? () => {} : add} />
      <ChatPromptInput
        value={value}
        inputRef={inputRef}
        status={busy ? "streaming" : "ready"}
        isDisabled={disconnected || editLocked}
        placeholder={
          busy
            ? "Steer the running turn…"
            : composerPlaceholder("Ask", {
                agents: roles.length > 0,
                files: fileSource !== undefined,
                commands: listsCommands,
                skills: skills.trigger !== undefined,
              })
        }
        onValueChange={setValue}
        onSubmit={() => submit("steer")}
        onFocus={() => {
          skills.request();
          slash.request();
        }}
        triggers={triggers.length === 0 ? undefined : triggers}
        onStop={busy ? () => void remote.controller.abort() : undefined}
        attachments={attachmentDrawer({ images, pending: imagesPending, onRemove: remove })}
        hasAttachments={images.length > 0}
        onFiles={editLocked ? undefined : add}
        error={commandError ?? error}
        startActions={
          <>
            <ChatAddMenu
              isDisabled={disconnected || editLocked}
              // Refetch on open so the Commands flyout's list and disabled reasons are current.
              onOpenChange={(open) => {
                if (open) slash.request(true);
              }}
            >
              <ChatAddMenuSection title="Add">
                <DropdownMenuItem label={addImages} isDisabled={!accepts} onClick={() => fileInput.current?.click()} />
                {fileSource === undefined ? null : (
                  <DropdownMenuItem label="Mention a file…" onClick={() => inputRef.current?.openTrigger("@./")} />
                )}
                {skills.trigger === undefined ? null : (
                  <DropdownMenuItem label="Use a skill…" onClick={() => inputRef.current?.openTrigger("$")} />
                )}
                {roles.length === 0 ? null : (
                  <DropdownMenuItem label="Mention an agent…" onClick={() => inputRef.current?.openTrigger("@")} />
                )}
              </ChatAddMenuSection>
              {/* Commands act on the conversation, not the message — where Compact sat before 5.15. */}
              <ChatAddMenuSection title="Conversation">
                {!listsCommands ? (
                  <DropdownMenuItem label="Compact conversation" onClick={() => void remote.controller.compact(undefined)} />
                ) : commandsUnavailable !== undefined ? (
                  <DropdownMenuSubMenu description={commandsUnavailable} isDisabled label="Commands">
                    {null}
                  </DropdownMenuSubMenu>
                ) : (
                  // Picking one starts the draft with `/name `, like typing it:
                  // arguments follow, and Enter runs it through the send path.
                  <DropdownMenuSubMenu label="Commands">
                    {(slash.commands ?? []).map((command) => (
                      <DropdownMenuItem
                        key={command.name}
                        description={command.disabled ?? command.description}
                        isDisabled={command.disabled !== undefined}
                        label={`/${command.name}`}
                        onClick={() => {
                          setValue(`/${command.name} `);
                          // A frame later: the menu's close hands focus back to its button first.
                          requestAnimationFrame(() => inputRef.current?.focusAtEnd());
                        }}
                      />
                    ))}
                  </DropdownMenuSubMenu>
                )}
              </ChatAddMenuSection>
            </ChatAddMenu>
            <ModelSelector
              models={view.models}
              selected={{ model: agent.model, level: agent.thinkingLevel ?? "off" }}
              isDisabled={disconnected}
              agent={
                role === undefined
                  ? undefined
                  : { kind: "fixed", name: role, description: roles.find((each) => each.name === role)?.description }
              }
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
              isDisabled={disconnected || imagesPending || editLocked}
              onClick={() => submit("followUp")}
            />
          ) : null
        }
      />
    </>
  );
}
