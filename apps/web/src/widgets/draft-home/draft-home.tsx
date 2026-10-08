import { Selector } from "@astryxdesign/core/Selector";
import { useRef, useState } from "react";
import type { Home } from "@pinomad/protocol/organization.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import type { DurableView } from "@pinomad/protocol/view.ts";
import { CheckoutStrategyPicker, ComposerLocationRow, ComposerStaticChip, type CheckoutMode } from "../../entities/checkout/composer-location-row.tsx";
import { ModelSelector } from "../../entities/model/model-selector.tsx";
import { useDraftModelPick } from "../../entities/model/use-draft-model-pick.ts";
import { ChatPromptInput, type ChatPromptInputHandle } from "@/shared/ui/chat/chat-prompt-input";
import { ChatPromptSuggestion } from "@/shared/ui/chat/chat-prompt-suggestion";
import { TextShimmer } from "@/shared/ui/chat/text-shimmer";
import { ChatAdd, FileDiff, FolderClosed, ListTree, SquareTerminal, Wrench } from "@/shared/ui/icons";

// Pace's four draft suggestions; representative first-touch prompts.
const SUGGESTED_PROMPTS = [
  { Icon: ListTree, label: "Explain this repo's architecture" },
  { Icon: Wrench, label: "Fix the failing test" },
  { Icon: SquareTerminal, label: "Add a CLI flag with docs" },
  { Icon: FileDiff, label: "Review my uncommitted changes" },
] as const;

/**
 * The draft screen: Pace's SessionDraftComposer layout — hero, project
 * picker, prompt input with the model · thinking capsule and the location
 * row, and suggestion pills.
 */
export function DraftHome({
  view,
  remote,
  draft,
  onDraft,
  connected,
}: {
  view: DurableView;
  remote: RemoteDurable;
  draft: Home;
  onDraft: (home: Home) => void;
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
  const { pick, setModel, setLevel } = useDraftModelPick(view);

  const location =
    draft.kind === "project" ? (
      <CheckoutStrategyPicker value={checkoutMode} onChange={setCheckoutMode} isDisabled={!connected} />
    ) : (
      <ComposerStaticChip chrome="selector" icon={ChatAdd} label="Chat" testId="composer-location-label" />
    );

  return (
    <section
      className="flex h-full min-h-0 flex-col items-center overflow-y-auto px-6 py-8"
      data-testid="draft-home"
    >
      <div className="mx-auto my-auto flex w-full max-w-[44rem] flex-col items-center justify-center gap-6">
        <h2 className="text-center text-3xl font-normal tracking-tight text-foreground max-lg:text-2xl">
          Build something useful with <TextShimmer tone="brand">PiNomad</TextShimmer>
        </h2>
        <div className="flex w-full flex-wrap justify-center gap-2">
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
                ? <ChatAdd aria-hidden="true" className="size-4 shrink-0" />
                : <FolderClosed aria-hidden="true" className="size-4 shrink-0" />
            }
            options={[
              { value: "chat", label: "No project", icon: <ChatAdd aria-hidden="true" className="size-4 shrink-0" /> },
              ...view.organized.projects.map((entry) => ({
                value: entry.project.path,
                label: entry.project.name,
                icon: <FolderClosed aria-hidden="true" className="size-4 shrink-0" />,
              })),
            ]}
            onChange={(picked) => onDraft(picked === "chat" ? { kind: "chat" } : { kind: "project", path: picked })}
          />
        </div>
        <div className="flex w-full flex-col gap-3">
          <ChatPromptInput
            accent="brand"
            accentFocusRing
            value={value}
            inputRef={inputRef}
            onValueChange={setValue}
            status={submitting ? "submitted" : "ready"}
            onSubmit={() => {
              const text = value.trim();
              if (text === "" || submittingRef.current) return;
              submittingRef.current = true;
              setSubmitting(true);
              void remote.controller
                .createConversation(draft, text, {
                  ...(draft.kind === "project" && checkoutMode === "local" ? { checkout: "project" as const } : {}),
                  ...(pick.model === undefined ? {} : { model: pick.model }),
                  thinkingLevel: pick.level,
                })
                .finally(() => {
                  submittingRef.current = false;
                  setSubmitting(false);
                });
            }}
            isDisabled={!connected}
            placeholder="Do anything with Pi"
            startActions={
              <ModelSelector
                models={view.models}
                selected={{ model: pick.model, level: pick.level }}
                isDisabled={!connected}
                onModelChange={setModel}
                onLevelChange={setLevel}
              />
            }
            footer={<ComposerLocationRow location={location} />}
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
