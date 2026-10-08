import { ChatComposer } from "@astryxdesign/core/Chat";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { Selector } from "@astryxdesign/core/Selector";
import { Switch } from "@astryxdesign/core/Switch";
import type { ModelRef } from "@earendil-works/pi-durable";
import { useRef, useState } from "react";
import type { Home } from "@pinomad/protocol/organization.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import type { DurableView, ModelSummary, ThinkingLevel } from "@pinomad/protocol/view.ts";
import { ChatPromptSuggestion } from "@/shared/ui/chat/chat-prompt-suggestion";
import { TextShimmer } from "@/shared/ui/chat/text-shimmer";
import { ChatAdd, FileDiff, FolderClosed, ListTree, SquareTerminal, Wrench } from "@/shared/ui/icons";

const DRAFT_MODEL_KEY = "pinomad.draft.model";

// pi-ai's thinking-level order; used to clamp a stored/default level down to
// what the picked model supports (highest supported level not above it).
const LEVEL_ORDER: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

const clampLevel = (levels: readonly ThinkingLevel[], want: ThinkingLevel): ThinkingLevel => {
  if (levels.includes(want)) return want;
  const wantIndex = LEVEL_ORDER.indexOf(want);
  return levels.filter((level) => LEVEL_ORDER.indexOf(level) <= wantIndex).at(-1) ?? "off";
};

// Pace's four draft suggestions; representative first-touch prompts.
const SUGGESTED_PROMPTS = [
  { Icon: ListTree, label: "Explain this repo's architecture" },
  { Icon: Wrench, label: "Fix the failing test" },
  { Icon: SquareTerminal, label: "Add a CLI flag with docs" },
  { Icon: FileDiff, label: "Review my uncommitted changes" },
] as const;

interface DraftPick {
  readonly provider: string;
  readonly modelId: string;
  readonly thinkingLevel: string;
}

/** The last draft pick, only when its model is still listed. */
function readDraftPick(models: readonly ModelSummary[]): DraftPick | undefined {
  try {
    const raw = localStorage.getItem(DRAFT_MODEL_KEY);
    if (raw === null) return undefined;
    const pick = JSON.parse(raw) as Partial<DraftPick>;
    if (
      typeof pick.provider === "string"
      && typeof pick.modelId === "string"
      && typeof pick.thinkingLevel === "string"
      && models.some((model) => model.provider === pick.provider && model.modelId === pick.modelId)
    ) {
      return pick as DraftPick;
    }
  } catch {
    // A malformed entry is dropped rather than blocking the draft.
  }
  return undefined;
}

const summaryOf = (models: readonly ModelSummary[], ref: ModelRef | undefined): ModelSummary | undefined =>
  ref === undefined ? undefined : models.find((each) => each.provider === ref.provider && each.modelId === ref.modelId);

const refOf = (summary: ModelSummary): ModelRef => ({ provider: summary.provider, modelId: summary.modelId });

/**
 * The draft screen: Pace's SessionDraftComposer layout — hero, project
 * picker, composer with model/thinking menus, and suggestion pills.
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
  // ADR-0010: project conversations default to a fresh worktree; this switch opts out.
  const [direct, setDirect] = useState(false);
  const composerRef = useRef<HTMLDivElement>(null);
  const [pick, setPick] = useState<{ model: ModelRef | undefined; level: ThinkingLevel }>(() => {
    const stored = readDraftPick(view.models);
    const model: ModelRef | undefined =
      stored !== undefined
        ? { provider: stored.provider, modelId: stored.modelId }
        : view.defaults.model ?? (view.models[0] === undefined ? undefined : refOf(view.models[0]));
    const levels = summaryOf(view.models, model)?.thinkingLevels ?? ["off"];
    const want = (stored?.thinkingLevel ?? view.defaults.thinkingLevel ?? "off") as ThinkingLevel;
    return { model, level: clampLevel(levels, want) };
  });

  const remember = (model: ModelRef, level: ThinkingLevel): void => {
    localStorage.setItem(DRAFT_MODEL_KEY, JSON.stringify({ ...model, thinkingLevel: level }));
  };

  const levels = summaryOf(view.models, pick.model)?.thinkingLevels ?? ["off"];
  const modelItems = view.models.map((model) => ({
    label: `${model.provider}/${model.modelId}`,
    onClick: () => {
      const level = clampLevel(model.thinkingLevels, pick.level);
      setPick({ model: refOf(model), level });
      remember(refOf(model), level);
    },
  }));
  const thinkingDisabled = !connected || levels.length <= 1;

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
        <div ref={composerRef} className="flex w-full flex-col gap-3">
          {draft.kind !== "project" ? null : (
            <Switch
              label="Work directly in project directory"
              size="sm"
              value={direct}
              onChange={setDirect}
              isDisabled={!connected}
            />
          )}
          <ChatComposer
            value={value}
            onChange={setValue}
            onSubmit={(text) => {
              void remote.controller.createConversation(draft, text, {
                ...(draft.kind === "project" && direct ? { checkout: "project" as const } : {}),
                ...(pick.model === undefined ? {} : { model: pick.model }),
                thinkingLevel: pick.level,
              });
            }}
            isDisabled={!connected}
            placeholder="Do anything with Pi"
            footerActions={
              <>
                <DropdownMenu
                  button={{
                    label: pick.model === undefined ? "No model" : `${pick.model.provider}/${pick.model.modelId}`,
                    variant: "ghost",
                    size: "sm",
                    isDisabled: !connected,
                  }}
                  items={modelItems}
                />
                <DropdownMenu
                  button={{
                    label: `Thinking: ${pick.level}`,
                    variant: "ghost",
                    size: "sm",
                    isDisabled: thinkingDisabled,
                  }}
                  items={levels.map((level) => ({
                    label: level,
                    onClick: () => {
                      if (pick.model !== undefined) remember(pick.model, level);
                      setPick((current) => ({ ...current, level }));
                    },
                  }))}
                />
              </>
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
                  // ChatComposer's input is a contentEditable region, not a textarea.
                  (composerRef.current?.querySelector("[contenteditable]") as HTMLElement | null)?.focus();
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
