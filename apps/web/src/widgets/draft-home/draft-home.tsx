import { Selector } from "@astryxdesign/core/Selector";
import { Text } from "@astryxdesign/core/Text";
import { useRef, useState } from "react";
import { hostSupportsCall, hostSupportsFeature } from "@pinomad/protocol/frames.ts";
import type { Home } from "@pinomad/protocol/organization.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import type { DurableView } from "@pinomad/protocol/view.ts";
import { CheckoutStrategyPicker, type CheckoutMode } from "../../entities/checkout/checkout-strategy-picker.tsx";
import { requestNotificationPermission } from "../../entities/conversation/notification-permission.ts";
import { useAtMentions, type MentionFiles } from "../../entities/agent/agent-mentions.tsx";
import { useSkillDraft, useSkillHighlight, useSkillMentions } from "../../entities/agent/skill-mentions.tsx";
import { draftMessage } from "../../entities/agent/skill-bindings.ts";
import { splitFiles } from "../../entities/attachment/file-attachments.ts";
import { FileAttachmentChip } from "../../entities/attachment/file-attachments.tsx";
import { useFileAttachments } from "../../entities/attachment/use-file-attachments.ts";
import { attachmentDrawer, FilePickerInput, ImageFileInput } from "../../entities/image/attachments.tsx";
import { useImageAttachments } from "../../entities/image/use-image-attachments.ts";
import { ModelSelector } from "../../entities/model/model-selector.tsx";
import { useDraftModelPick } from "../../entities/model/use-draft-model-pick.ts";
import { summaryOf, type AgentDraftProblem } from "@pinomad/client/model.ts";
import { ChatAddMenu, ChatAddMenuItem } from "@/shared/ui/chat/chat-add-menu";
import { ChatPromptInput, type ChatPromptInputHandle } from "@/shared/ui/chat/chat-prompt-input";
import { composerPlaceholder } from "@/shared/ui/chat/chat-placeholder";
import { Bot, ChatAdd, FileIcon, FolderClosed, ImageIcon, Sparkles } from "@/shared/ui/icons";
import { PinomadMark } from "@/shared/ui/pinomad-mark";

/** The capsule's red line + tooltip for a draft problem the host would refuse. */
function problemText(problem: AgentDraftProblem): { label: string; title: string } {
  switch (problem.kind) {
    case "agent-missing":
      return {
        label: `@${problem.agent} unavailable`,
        title: `Agent @${problem.agent} is not defined on this host${problem.reason === undefined ? "" : ` — ${problem.reason}`}`,
      };
    case "model-missing":
      return {
        label: `No model for @${problem.agent}`,
        title: `Agent @${problem.agent} pins no model and the host has no default`,
      };
    case "model-unavailable": {
      const model = `${problem.model.provider}/${problem.model.modelId}`;
      const from =
        problem.source === "agent" ? `@${problem.agent}'s model` : problem.source === "default" ? "the host default" : "the picked model";
      return { label: `${model} unavailable`, title: `${model} (${from}) is not in the host's model list` };
    }
  }
}

/**
 * The draft screen: hero, then the prompt input with the model · thinking
 * capsule and, in the tray under it, where the conversation will run
 * (project, then worktree or project folder).
 */
export function DraftHome({
  view,
  remote,
  draft,
  onDraft,
  onCreated,
  connected,
}: {
  view: DurableView;
  remote: RemoteDurable;
  draft: Home;
  onDraft: (home: Home) => void;
  /** The draft became a conversation, now shown; a failed create does not call it. */
  onCreated: () => void;
  connected: boolean;
}) {
  // A plain string plus the `$` picks bound in it (ADR-0028).
  const skillDraft = useSkillDraft();
  const { value, setValue } = skillDraft;
  // createConversation keeps the text and resolves after the view switches
  // (a failure still resolves, as a notice). The ref guards synchronously —
  // setState hasn't flushed by the time a second Enter's keydown runs.
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  // ADR-0010: project conversations default to a fresh worktree; the picker opts out.
  const [checkoutMode, setCheckoutMode] = useState<CheckoutMode>("worktree");
  const inputRef = useRef<ChatPromptInputHandle | null>(null);
  const { pick, setModel, setLevel, agent, setAgent, resolution } = useDraftModelPick(view);
  const model = summaryOf(view.models, pick.model);
  const accepts = model?.images === true;
  const { images, pending, error, add, remove } = useImageAttachments(accepts);
  const fileInput = useRef<HTMLInputElement>(null);
  const minor = view.host?.protocol.minor;
  const attachmentsEnabled =
    minor !== undefined
    && hostSupportsFeature(minor, "attachments")
    && hostSupportsCall(minor, "beginAttachment");
  const files = useFileAttachments(remote, attachmentsEnabled);
  const attachInput = useRef<HTMLInputElement>(null);
  const [fileSubmitError, setFileSubmitError] = useState<string | undefined>(undefined);
  const addFiles = (incoming: File[]): void => {
    const { images: pickedImages, others } = splitFiles(incoming);
    setFileSubmitError(undefined);
    if (pickedImages.length > 0) add(pickedImages);
    if (others.length > 0) files.add(others);
  };
  const agentRoles = view.agents?.roles ?? [];
  // The picker stays up while a pick survives a now-empty snapshot so the
  // user can clear it — an empty roles list alone hides it.
  const showAgentPicker =
    minor !== undefined
    && hostSupportsFeature(minor, "agentConversations")
    && (agentRoles.length > 0 || agent !== undefined);
  // The project's file listing for `@` completion.
  const fileSource: MentionFiles | undefined =
    draft.kind === "project" && minor !== undefined && hostSupportsCall(minor, "listFiles")
      ? {
          key: `project:${draft.path}:${checkoutMode}`,
          list: (query) =>
            remote.controller.listFiles(
              { kind: "project", path: draft.path, checkout: checkoutMode === "local" ? "project" : "worktree" },
              query,
            ),
        }
      : undefined;
  const atMentions = useAtMentions(view.agents, inputRef, fileSource);
  // `$` skill mentions (issue #143): a project draft scopes to the project
  // (worktree mode lists only the skills a fresh checkout would carry); a
  // Chat draft lists the user's skills.
  const skills = useSkillMentions(
    remote,
    draft.kind === "project"
      ? { kind: "project", path: draft.path, checkout: checkoutMode === "local" ? "project" : "worktree" }
      : { kind: "chat" },
    inputRef,
    connected && minor !== undefined && hostSupportsCall(minor, "listSkills"),
    skillDraft.pick,
  );
  useSkillHighlight(inputRef, skillDraft.draft);
  const triggers = [...(atMentions ?? []), ...(skills.trigger === undefined ? [] : [skills.trigger])];
  const problem = resolution?.problem;
  // An inherited side reads "from @name" — the side the user overrode drops it.
  const sourceHint =
    agent === undefined || resolution === undefined
      ? undefined
      : resolution.modelFrom !== "override" && resolution.levelFrom !== "override"
        ? `from @${agent}`
        : resolution.modelFrom !== "override"
          ? `model from @${agent}`
          : resolution.levelFrom !== "override"
            ? `level from @${agent}`
            : undefined;
  const imagesUnavailable =
    accepts || !connected ? undefined : `${model?.name ?? pick.model?.modelId ?? "This model"} can't see images`;

  return (
    <section
      className="flex h-full min-h-0 flex-col items-center overflow-y-auto px-6 py-8"
      data-testid="draft-home"
    >
      <div className="mx-auto my-auto flex w-full max-w-[44rem] flex-col items-center justify-center gap-6">
        <PinomadMark className="size-14 text-foreground" />
        <h2 className="text-center text-3xl font-normal tracking-tight text-foreground max-lg:text-2xl">
          Build something useful with PiNomad
        </h2>
        <div className="flex w-full flex-col gap-3">
          <ImageFileInput inputRef={fileInput} onFiles={add} />
          <FilePickerInput inputRef={attachInput} onFiles={addFiles} />
          {files.uploading ? <Text type="supporting">Uploading files…</Text> : null}
          <ChatPromptInput
            value={value}
            inputRef={inputRef}
            onValueChange={setValue}
            onFocus={skills.request}
            triggers={triggers.length === 0 ? undefined : triggers}
            status={submitting ? "submitted" : "ready"}
            onSubmit={() => {
              // Only the picked skills go out as `skills` (ADR-0028).
              const message = draftMessage(skillDraft.draft);
              const text = message.text.trim();
              if (
                (text === "" && images.length === 0 && files.entries.length === 0)
                || files.uploading
                || files.failed
                || pending
                || submittingRef.current
                || problem !== undefined
              ) return;
              requestNotificationPermission();
              // The shown conversation changes only when the create landed.
              const shown = remote.view.current().conversation?.conversation.id;
              const sending = images;
              const attachments = files.ids();
              submittingRef.current = true;
              setSubmitting(true);
              // No await before the call: the draft's files are all done, and
              // click order reaches the controller's command queue intact.
              void remote.controller
                .createConversation(draft, text, {
                  ...(draft.kind === "project" && checkoutMode === "local" ? { checkout: "project" as const } : {}),
                  // With a named agent only the overrides go — inherited model
                  // and level resolve host-side from the role at create.
                  ...(resolution === undefined
                    ? { ...(pick.model === undefined ? {} : { model: pick.model }), thinkingLevel: pick.level }
                    : resolution.send),
                  ...(sending.length === 0 ? {} : { images: sending }),
                  skills: message.skills,
                  ...(attachments.length === 0 ? {} : { attachments }),
                })
                .then(() => {
                  const now = remote.view.current().conversation?.conversation.id;
                  if (now !== undefined && now !== shown) onCreated();
                })
                .finally(() => {
                  submittingRef.current = false;
                  setSubmitting(false);
                });
            }}
            isDisabled={!connected}
            submitDisabled={problem !== undefined || files.uploading || files.failed}
            placeholder={composerPlaceholder("Do anything with Pi", {
              agents: agentRoles.length > 0,
              files: fileSource !== undefined,
              commands: false,
              skills: skills.trigger !== undefined,
            })}
            attachments={attachmentDrawer({
              images,
              pending,
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
            onFiles={addFiles}
            error={error ?? files.error ?? fileSubmitError}
            startActions={
              <>
                <ChatAddMenu isDisabled={!connected}>
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
                    <ChatAddMenuItem
                      icon={Sparkles}
                      label="Use a skill…"
                      hint="Or type $"
                      onClick={() => inputRef.current?.openTrigger("$")}
                    />
                  )}
                  {agentRoles.length === 0 ? null : (
                    <ChatAddMenuItem
                      icon={Bot}
                      label="Mention an agent…"
                      hint="Or type @"
                      onClick={() => inputRef.current?.openTrigger("@")}
                    />
                  )}
                </ChatAddMenu>
                <ModelSelector
                  models={view.models}
                  selected={{ model: pick.model, level: pick.level }}
                  isDisabled={!connected}
                  agent={showAgentPicker ? { kind: "pick", roles: agentRoles, value: agent, onChange: setAgent } : undefined}
                  sourceHint={sourceHint}
                  {...(problem === undefined ? {} : { problem: problemText(problem) })}
                  onModelChange={setModel}
                  onLevelChange={setLevel}
                />
              </>
            }
            footer={
              <span className="flex w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <Selector
                  isLabelHidden
                  label="Project"
                  placeholder="No project"
                  placement="below"
                  variant="ghost"
                  size="sm"
                  isDisabled={!connected}
                  value={draft.kind === "chat" ? "chat" : draft.path}
                  startIcon={
                    draft.kind === "chat"
                      ? <ChatAdd aria-hidden="true" className="size-4 shrink-0 text-muted" />
                      : <FolderClosed aria-hidden="true" className="size-4 shrink-0 text-muted" />
                  }
                  options={[
                    { value: "chat", label: "No project", icon: <ChatAdd aria-hidden="true" className="size-4 shrink-0 text-muted" /> },
                    ...view.organized.projects.map((entry) => ({
                      value: entry.project.path,
                      label: entry.project.name,
                      icon: <FolderClosed aria-hidden="true" className="size-4 shrink-0 text-muted" />,
                    })),
                  ]}
                  onChange={(picked) => onDraft(picked === "chat" ? { kind: "chat" } : { kind: "project", path: picked })}
                />
                {draft.kind === "project" ? (
                  <CheckoutStrategyPicker value={checkoutMode} onChange={setCheckoutMode} isDisabled={!connected} />
                ) : null}
              </span>
            }
          />
        </div>
      </div>
    </section>
  );
}
