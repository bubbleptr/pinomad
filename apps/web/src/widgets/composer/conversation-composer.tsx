import { Button } from "@astryxdesign/core/Button";
import { Text } from "@astryxdesign/core/Text";
import { useToast } from "@astryxdesign/core/Toast";
import { useEffect, useRef, useState } from "react";
import { hostSupportsCall, hostSupportsFeature } from "@pinomad/protocol/frames.ts";
import type { MessageImage, ViewImage } from "@pinomad/protocol/images.ts";
import { findConversation } from "@pinomad/protocol/organization.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import type { DurableView, SubmissionDraft } from "@pinomad/protocol/view.ts";
import { currentAgentOf } from "../../entities/conversation/current-agent.ts";
import { requestNotificationPermission } from "../../entities/conversation/notification-permission.ts";
import { useAtMentions, type MentionFiles } from "../../entities/agent/agent-mentions.tsx";
import { useSkillDraft, useSkillHighlight, useSkillMentions } from "../../entities/agent/skill-mentions.tsx";
import { draftMessage } from "../../entities/agent/skill-bindings.ts";
import { useSlashCommands } from "../../entities/command/slash-commands.tsx";
import { splitFiles } from "../../entities/attachment/file-attachments.ts";
import { FileAttachmentChip } from "../../entities/attachment/file-attachments.tsx";
import { useFileAttachments } from "../../entities/attachment/use-file-attachments.ts";
import { attachmentDrawer, FilePickerInput, ImageFileInput } from "../../entities/image/attachments.tsx";
import { loadImageBytes, primeImages } from "../../entities/image/image-cache.ts";
import { useComposerSlot } from "../../entities/composer/composer-context.tsx";
import { conversationDraftKey } from "../../entities/composer/composer-store.ts";
import { useImageAttachments } from "../../entities/image/use-image-attachments.ts";
import { ModelSelector } from "../../entities/model/model-selector.tsx";
import { agentOf, queueItems, queuedInput, statusText, type QueueItem } from "@pinomad/client/chat.ts";
import { parseCommandInput } from "@pinomad/client/command-input.ts";
import { summaryOf } from "@pinomad/client/model.ts";
import { ChatAddMenu, ChatAddMenuItem } from "../../shared/ui/chat/chat-add-menu.tsx";
import { ChatPromptInput, type ChatPromptInputHandle } from "../../shared/ui/chat/chat-prompt-input.tsx";
import { composerPlaceholder } from "../../shared/ui/chat/chat-placeholder.ts";
import { ArchiveArrowDown, Bot, CommandLine, FileIcon, ImageIcon, Sparkles } from "@/shared/ui/icons";
import { QueuedList } from "./queued-list.tsx";

/** A queued edit's images as bytes, or undefined when any one cannot load. */
async function resolveImages(
  images: readonly ViewImage[],
  load: (ref: string) => Promise<MessageImage>,
  source?: string,
): Promise<MessageImage[] | undefined> {
  try {
    return await Promise.all(images.map((image) => loadImageBytes(image, load, source)));
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
  takeBack,
  onTakeBack,
  externalEditLocked = false,
  onEditorStateChange,
  source,
}: {
  view: DurableView;
  remote: RemoteDurable;
  conversation: NonNullable<DurableView["conversation"]>;
  busy: boolean;
  narrow: boolean;
  /** A send taken back from the transcript, to restore into this composer. */
  takeBack?: SubmissionDraft;
  onTakeBack?: () => void;
  /** A transcript Edit is resolving/removing a submission right now. */
  externalEditLocked?: boolean;
  /** Let a transcript Edit disable itself while this composer holds a draft. */
  onEditorStateChange?: (state: { occupied: boolean; locked: boolean }) => void;
  /** The hostKey answering image requests, so its in-flight work stays separate. */
  source?: string;
}) {
  // The host-scoped slot keeps the draft and its uploads alive when focus
  // moves to another host.
  const slot = useComposerSlot(conversationDraftKey(conversation.conversation.id));
  // A plain string plus the `$` picks bound in it (ADR-0028).
  const skillDraft = useSkillDraft(slot);
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
  const conversationId = conversation.conversation.id;
  const inputRef = useRef<ChatPromptInputHandle | null>(null);
  // A Chat conversation has no project files; like a Chat draft, its `@`
  // offers agents only.
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
  const queue = queueItems(conversation, view.submissions ?? []);
  const roles = view.agents?.roles ?? [];
  const summary = findConversation(view.organized, conversation.conversation.id)?.summary;
  // The creation agent is all a pre-5.18 host knows; 5.18 adds currentAgent.
  const role = summary?.role;
  const currentAgent = currentAgentOf(summary);
  // Subagents take their role from the delegating call, so only top-level
  // conversations and forks may switch it (ADR-0023). Wait for the agents
  // snapshot: an empty roles list before it would look like a deleted agent.
  const canSwitchAgent =
    summary !== undefined
    && summary.kind !== "subagent"
    && view.agents !== null
    && hostSupportsCall(view.host?.protocol.minor ?? 0, "setAgent");

  const model = summaryOf(view.models, agent.model);
  const accepts = model?.images === true;
  const { images, pending: imagesPending, error, add, restore, remove, clear } = useImageAttachments(accepts, slot);
  const attachmentsEnabled =
    hostSupportsFeature(view.host?.protocol.minor ?? 0, "attachments")
    && hostSupportsCall(view.host?.protocol.minor ?? 0, "beginAttachment");
  const files = useFileAttachments(remote, attachmentsEnabled, slot);
  const attachInput = useRef<HTMLInputElement>(null);
  const [fileSubmitError, setFileSubmitError] = useState<string | undefined>(undefined);
  const addFiles = (incoming: File[]): void => {
    const { images: pickedImages, others } = splitFiles(incoming);
    setFileSubmitError(undefined);
    if (pickedImages.length > 0) add(pickedImages);
    if (others.length > 0) files.add(others);
  };
  // Why a typed command wasn't run; any edit to the draft clears it.
  const [commandError, setCommandError] = useState<string | undefined>(undefined);
  useEffect(() => setCommandError(undefined), [value, images.length, files.entries.length]);
  // Why the + menu's Run a command… can't open: a command starts at index 0,
  // so picking one into a draft with a message would bury or replace it.
  const commandsUnavailable =
    slash.commands === undefined
      ? "Loading…"
      : slash.commands.length === 0
        ? "None on this host"
        : value.trim() !== "" || images.length > 0 || files.entries.length > 0 || imagesPending || files.uploading
          ? "Clear the message first"
          : undefined;
  const fileInput = useRef<HTMLInputElement>(null);
  const imagesUnavailable =
    accepts || disconnected ? undefined : `${model?.name ?? agent.model?.modelId ?? "This model"} can't see images`;

  // Queued-input calls are requests, not commands: their outcomes and errors
  // come back here instead of becoming host notices. One request per row at a
  // time; the ref makes a double click before the next render a no-op too.
  type PendingAction = { id: number; kind: "steer" | "withdraw" | "edit" };
  const [pendingActions, setPendingActions] = useState<readonly PendingAction[]>([]);
  const pendingRows = useRef(new Set<number>());
  const [pendingSubmissions, setPendingSubmissions] = useState<readonly string[]>([]);
  const pendingSubmissionRows = useRef(new Set<string>());
  const [localEditInFlight, setLocalEditInFlight] = useState(false);
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
  const composerOccupied = value.trim() !== "" || images.length > 0 || files.entries.length > 0 || imagesPending;
  const editDisabled = composerOccupied || editInFlight || awaitingEdit || localEditInFlight || externalEditLocked;
  const editTooltip = composerOccupied
    ? "Clear the composer to edit"
    : editDisabled
      ? "Finish the current edit first"
      : undefined;
  // While an edit resolves its images/withdraws, or its outcome is unknown
  // after an error, the composer and every attachment entry stay locked: a
  // later refill must not overwrite something the user wrote in the meantime.
  const editLocked = editInFlight || awaitingEdit || localEditInFlight || externalEditLocked;
  useEffect(() => {
    onEditorStateChange?.({ occupied: composerOccupied, locked: editInFlight || awaitingEdit || localEditInFlight });
  }, [composerOccupied, editInFlight, awaitingEdit, localEditInFlight, onEditorStateChange]);
  const canAct = !disconnected && hostSupportsCall(view.host?.protocol.minor ?? 0, "withdrawQueued");
  const showError = (error: unknown): void => {
    toast({ body: error instanceof Error ? error.message : String(error), type: "error" });
  };

  const submissionAction = async (requestId: string, action: () => Promise<void>): Promise<void> => {
    if (pendingSubmissionRows.current.has(requestId)) return;
    pendingSubmissionRows.current.add(requestId);
    setPendingSubmissions((current) => [...current, requestId]);
    try {
      await action();
    } catch (error) {
      showError(error);
    } finally {
      pendingSubmissionRows.current.delete(requestId);
      setPendingSubmissions((current) => current.filter((id) => id !== requestId));
    }
  };
  const retryLocal = (requestId: string): void => {
    void submissionAction(requestId, () => remote.controller.retrySubmission(requestId));
  };
  const editLocal = (requestId: string): void => {
    // The controller resolves ref images before removing the row; this guard
    // keeps a double click or a stale render from overwriting a new draft.
    if (editDisabled) return;
    setLocalEditInFlight(true);
    void submissionAction(requestId, async () => {
      const draft = await remote.controller.takeBackSubmission(requestId);
      if (draft === undefined) return;
      skillDraft.restore(draft.text, draft.skills);
      // Every image was resolved before the take-back, so bytes are all that
      // the composer needs to stage them again.
      restore(draft.images.flatMap((image) => ("data" in image ? [image] : [])));
      files.restore(draft.attachmentDetails ?? []);
      setFocusAfterEdit((count) => count + 1);
    }).finally(() => setLocalEditInFlight(false));
  };
  const withdraw = async (item: QueueItem): Promise<void> => {
    const id = item.id;
    if (id === undefined || !beginAction(id, "withdraw")) return;
    try {
      if ((await remote.controller.withdrawQueued(id, conversationId)) === "sent") {
        toast({ body: "Already sent — can't withdraw" });
      }
    } catch (error) {
      showError(error);
    } finally {
      endAction(id);
    }
  };
  const steer = async (item: QueueItem): Promise<void> => {
    const id = item.id;
    if (id === undefined || !beginAction(id, "steer")) return;
    try {
      // "sent"/"unavailable" have nothing to say: the message is already out,
      // or someone else settled it before the promotion landed.
      await remote.controller.steerQueued(id, conversationId);
    } catch (error) {
      showError(error);
    } finally {
      endAction(id);
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
      const resolved = await resolveImages(copy.input.images, (ref) => remote.controller.image(ref), source);
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
        // The slot survives this component; a focus switch while the images
        // loaded still finds the restored draft when this composer returns.
        skillDraft.restore(copy.input.text, copy.input.skills);
        restore(resolved);
        files.restore(copy.input.attachments);
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
    if (item.id === undefined) {
      if (item.requestId !== undefined) editLocal(item.requestId);
      return;
    }
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
  // A transcript's Edit takes the send back through the controller; restoring
  // it here keeps skill picks and file chips, not just the text.
  useEffect(() => {
    if (takeBack === undefined) return;
    skillDraft.restore(takeBack.text, takeBack.skills);
    restore(takeBack.images.flatMap((image) => ("data" in image ? [image] : [])));
    files.restore(takeBack.attachmentDetails ?? []);
    setFocusAfterEdit((count) => count + 1);
    onTakeBack?.();
    // The draft object changes once per take-back; its contents are immutable.
  }, [takeBack]);

  const submit = (whenBusy: "steer" | "followUp"): void => {
    // Only the picked skills go out as `skills` (ADR-0028).
    const message = draftMessage(skillDraft.draft);
    const text = message.text.trim();
    // No await on this path: a conversation switch or new input can never
    // overtake the send, and a file still uploading simply blocks it.
    if (
      editLocked
      || files.uploading
      || (text === "" && images.length === 0 && files.entries.length === 0)
      || imagesPending
    ) {
      return;
    }
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
      if (files.entries.length > 0) {
        setCommandError("Commands can't include files");
        return;
      }
      void remote.controller.runCommand(command.name, command.args);
      setValue("");
      return;
    }
    requestNotificationPermission();
    if (files.failed) {
      setFileSubmitError("Some files failed to upload — retry or remove them");
      return;
    }
    const sending = images;
    const attachments = files.ids();
    const attachmentDetails = files.details();
    // Staged images were primed before they became sendable, so this enters
    // the controller's ordered queue in click order with no intervening await.
    void remote.controller.submit(text, whenBusy, {
      images: sending,
      // Inline bytes already render from `images`; only refs need their type.
      ...(sending.some((image) => !("data" in image)) ? { imageViews: sending } : {}),
      skills: message.skills,
      ...(attachments.length === 0 ? {} : { attachments }),
      ...(attachmentDetails.length === 0 ? {} : { attachmentDetails }),
    });
    setValue("");
    clear();
    files.clear();
    setFileSubmitError(undefined);
  };

  return (
    <>
      {status === "" && !files.uploading ? null : (
        <Text type="supporting">{files.uploading ? "Uploading files…" : status}</Text>
      )}
      <QueuedList
        items={queue}
        canAct={canAct}
        busy={busy}
        editDisabled={editDisabled}
        editTooltip={editTooltip}
        editRetryId={awaitingEdit ? editCopy.current?.id : undefined}
        narrow={narrow}
        pendingIds={pendingIds}
        pendingRequestIds={new Set(pendingSubmissions)}
        onSteer={(item) => void steer(item)}
        onRetry={(item) => {
          if (item.requestId !== undefined) retryLocal(item.requestId);
        }}
        onEdit={(item) => void edit(item)}
        onWithdraw={(item) => void withdraw(item)}
      />
      <ImageFileInput inputRef={fileInput} onFiles={editLocked ? () => {} : add} />
      <FilePickerInput inputRef={attachInput} onFiles={editLocked ? () => {} : addFiles} />
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
        attachments={attachmentDrawer({
          images,
          pending: imagesPending,
          onRemove: remove,
          ...(files.entries.length === 0
            ? {}
            : {
                files: (
                  <>
                    {files.entries.map((entry) => (
                      <FileAttachmentChip
                        key={entry.key}
                        entry={entry}
                        onRetry={files.retry}
                        onRemove={files.remove}
                      />
                    ))}
                  </>
                ),
              }),
        })}
        hasAttachments={images.length > 0 || files.entries.length > 0}
        onFiles={editLocked ? undefined : addFiles}
        error={commandError ?? error ?? files.error ?? fileSubmitError}
        submitDisabled={files.uploading || files.failed}
        startActions={
          <>
            <ChatAddMenu
              isDisabled={disconnected || editLocked}
              // Refetch on open so Run a command…'s disabled reason is current.
              onOpenChange={(open) => {
                if (open) slash.request(true);
              }}
            >
              <ChatAddMenuItem
                icon={ImageIcon}
                label="Add images…"
                hint={imagesUnavailable ?? "Or paste or drop"}
                isDisabled={!accepts}
                onClick={() => fileInput.current?.click()}
              />
              {attachmentsEnabled ? (
                <ChatAddMenuItem
                  icon={FileIcon}
                  label="Attach files…"
                  hint="Up to 10 · 10 MB each"
                  onClick={() => attachInput.current?.click()}
                />
              ) : null}
              {skills.trigger === undefined ? null : (
                <ChatAddMenuItem icon={Sparkles} label="Use a skill…" hint="Or type $" onClick={() => inputRef.current?.openTrigger("$")} />
              )}
              {roles.length === 0 ? null : (
                <ChatAddMenuItem icon={Bot} label="Mention an agent…" hint="Or type @" onClick={() => inputRef.current?.openTrigger("@")} />
              )}
              {!listsCommands ? (
                <ChatAddMenuItem
                  icon={ArchiveArrowDown}
                  label="Compact conversation"
                  hint="Frees up context"
                  onClick={() => void remote.controller.compact(undefined)}
                />
              ) : (
                // Opens the `/` menu, as typing `/` at the start would.
                <ChatAddMenuItem
                  icon={CommandLine}
                  label="Run a command…"
                  hint={commandsUnavailable ?? "Or type /"}
                  isDisabled={commandsUnavailable !== undefined}
                  onClick={() => inputRef.current?.openTrigger("/")}
                />
              )}
            </ChatAddMenu>
            <ModelSelector
              models={view.models}
              selected={{ model: agent.model, level: agent.thinkingLevel ?? "off" }}
              isDisabled={disconnected}
              agent={
                canSwitchAgent
                  ? {
                      kind: "pick",
                      roles,
                      value: currentAgent,
                      onChange: (name) => {
                        void remote.controller.setAgent(name ?? null).catch(showError);
                      },
                    }
                  : role === undefined
                    ? undefined
                    : { kind: "fixed", name: role, description: roles.find((each) => each.name === role)?.description }
              }
              onModelChange={(model) => void remote.controller.setModel(model)}
              onLevelChange={(level) => void remote.controller.setThinkingLevel(level)}
            />
          </>
        }
        endActions={
          busy && (value.trim() !== "" || images.length > 0 || files.entries.length > 0) ? (
            <Button
              label="Follow-up"
              variant="ghost"
              size={narrow ? "md" : "sm"}
              tooltip="Queue after the running turn"
              isDisabled={disconnected || imagesPending || editLocked || files.uploading || files.failed}
              onClick={() => submit("followUp")}
            />
          ) : null
        }
      />
    </>
  );
}
