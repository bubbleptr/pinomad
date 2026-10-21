import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { Selector } from "@astryxdesign/core/Selector";
import { useRef, useState } from "react";
import { hostSupportsCall, hostSupportsFeature } from "@pinomad/protocol/frames.ts";
import type { Home } from "@pinomad/protocol/organization.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import type { DurableView } from "@pinomad/protocol/view.ts";
import { CheckoutStrategyPicker, type CheckoutMode } from "../../entities/checkout/checkout-strategy-picker.tsx";
import { requestNotificationPermission } from "../../entities/conversation/notification-permission.ts";
import { AgentSelector } from "../../entities/agent/agent-selector.tsx";
import { useAtMentions } from "../../entities/agent/agent-mentions.tsx";
import { useSkillHighlight, useSkillMentions } from "../../entities/agent/skill-mentions.tsx";
import { attachmentDrawer, ImageFileInput } from "../../entities/image/attachments.tsx";
import { useImageAttachments } from "../../entities/image/use-image-attachments.ts";
import { ModelSelector } from "../../entities/model/model-selector.tsx";
import { useDraftModelPick } from "../../entities/model/use-draft-model-pick.ts";
import { summaryOf, type AgentDraftProblem } from "@pinomad/client/model.ts";
import { ChatPromptInput, type ChatPromptInputHandle } from "@/shared/ui/chat/chat-prompt-input";
import { ChatPromptSuggestion } from "@/shared/ui/chat/chat-prompt-suggestion";
import { ChatAdd, CommandLine, FileDiff, FolderClosed, ListTree, Plus, Wrench } from "@/shared/ui/icons";
import { PinomadMark } from "@/shared/ui/pinomad-mark";

// Pace's four draft suggestions; representative first-touch prompts.
const SUGGESTED_PROMPTS = [
  { Icon: ListTree, label: "Explain this repo's architecture" },
  { Icon: Wrench, label: "Fix the failing test" },
  { Icon: CommandLine, label: "Add a CLI flag with docs" },
  { Icon: FileDiff, label: "Review my uncommitted changes" },
] as const;

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
 * The draft screen: Pace's SessionDraftComposer layout — hero, prompt input
 * with the model · thinking capsule and, under it, where the conversation
 * will run (project, then worktree or project folder) — and suggestion pills.
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
  const [value, setValue] = useState("");
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
  const agentRoles = view.agents?.roles ?? [];
  // The picker stays up while a pick survives a now-empty snapshot so the
  // user can clear it — an empty roles list alone hides it.
  const showAgentPicker =
    minor !== undefined
    && hostSupportsFeature(minor, "agentConversations")
    && (agentRoles.length > 0 || agent !== undefined);
  const atMentions = useAtMentions(
    view.agents,
    inputRef,
    draft.kind === "project" && minor !== undefined && hostSupportsCall(minor, "listFiles")
      ? {
          key: `project:${draft.path}:${checkoutMode}`,
          list: (query) =>
            remote.controller.listFiles(
              { kind: "project", path: draft.path, checkout: checkoutMode === "local" ? "project" : "worktree" },
              query,
            ),
        }
      : undefined,
  );
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
  );
  useSkillHighlight(inputRef, value, skills.names);
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
  // No "why" slot on menu items: the reason goes into the label itself.
  const addImages =
    accepts || !connected
      ? "Add images…"
      : `Add images… (${model?.name ?? pick.model?.modelId ?? "This model"} can't see images)`;

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
          <ChatPromptInput
            value={value}
            inputRef={inputRef}
            onValueChange={setValue}
            onFocus={skills.request}
            triggers={triggers.length === 0 ? undefined : triggers}
            status={submitting ? "submitted" : "ready"}
            onSubmit={() => {
              const text = value.trim();
              if ((text === "" && images.length === 0) || pending || submittingRef.current || problem !== undefined) return;
              requestNotificationPermission();
              // The shown conversation changes only when the create landed.
              const shown = remote.view.current().conversation?.conversation.id;
              submittingRef.current = true;
              setSubmitting(true);
              void remote.controller
                .createConversation(draft, text, {
                  ...(draft.kind === "project" && checkoutMode === "local" ? { checkout: "project" as const } : {}),
                  // With a named agent only the overrides go — inherited model
                  // and level resolve host-side from the role at create.
                  ...(resolution === undefined
                    ? { ...(pick.model === undefined ? {} : { model: pick.model }), thinkingLevel: pick.level }
                    : resolution.send),
                  ...(images.length === 0 ? {} : { images }),
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
            submitDisabled={problem !== undefined}
            placeholder="Do anything with Pi"
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
                    isDisabled: !connected,
                  }}
                  items={[
                    {
                      label: addImages,
                      isDisabled: !connected || !accepts,
                      onClick: () => fileInput.current?.click(),
                    },
                  ]}
                />
                {showAgentPicker ? (
                  <AgentSelector agents={view.agents} value={agent} isDisabled={!connected} onChange={setAgent} />
                ) : null}
                <ModelSelector
                  models={view.models}
                  selected={{ model: pick.model, level: pick.level }}
                  isDisabled={!connected}
                  sourceHint={sourceHint}
                  {...(problem === undefined ? {} : { problem: problemText(problem) })}
                  onModelChange={setModel}
                  onLevelChange={setLevel}
                />
              </>
            }
            footer={
              <span className="flex w-full min-w-0 items-center gap-2">
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
        <ChatPromptSuggestion className="w-full max-w-[35rem]">
          <ChatPromptSuggestion.Items className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {SUGGESTED_PROMPTS.map(({ Icon, label }) => (
              <ChatPromptSuggestion.Item
                key={label}
                className="items-center justify-start"
                showEndIcon={false}
                onPress={() => {
                  setValue(label);
                  inputRef.current?.focusAtEnd();
                }}
              >
                <span className="inline-flex min-w-0 items-center gap-2">
                  <Icon aria-hidden="true" className="size-4 shrink-0" />
                  <span className="truncate">{label}</span>
                </span>
              </ChatPromptSuggestion.Item>
            ))}
          </ChatPromptSuggestion.Items>
        </ChatPromptSuggestion>
      </div>
    </section>
  );
}
