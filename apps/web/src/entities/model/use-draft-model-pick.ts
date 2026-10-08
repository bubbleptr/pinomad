import type { ModelRef } from "@earendil-works/pi-durable";
import { useState } from "react";
import type { DurableView, ModelSummary, ThinkingLevel } from "@pinomad/protocol/view.ts";

const DRAFT_MODEL_KEY = "pinomad.draft.model";

// pi-ai's thinking-level order; used to clamp a stored/default level down to
// what the picked model supports (highest supported level not above it).
const LEVEL_ORDER: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export const clampLevel = (levels: readonly ThinkingLevel[], want: ThinkingLevel): ThinkingLevel => {
  if (levels.includes(want)) return want;
  const wantIndex = LEVEL_ORDER.indexOf(want);
  return levels.filter((level) => LEVEL_ORDER.indexOf(level) <= wantIndex).at(-1) ?? "off";
};

export const summaryOf = (
  models: readonly ModelSummary[],
  ref: ModelRef | undefined,
): ModelSummary | undefined =>
  ref === undefined ? undefined : models.find((each) => each.provider === ref.provider && each.modelId === ref.modelId);

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

export interface DraftModelPick {
  readonly model?: ModelRef;
  readonly level: ThinkingLevel;
}

/**
 * The draft's model+level pick: restored from localStorage, falling back to
 * the host defaults, and persisted on every change. Changing the model
 * re-clamps the level to that model's supported levels.
 *
 * The returned pick is reconciled against `view.models` at render time, not
 * synced into state: after a reconnect whose hello lists different models, a
 * remembered pick falls back to the host defaults, then the first model.
 */
export function useDraftModelPick(view: DurableView): {
  pick: DraftModelPick;
  setModel: (model: ModelRef) => void;
  setLevel: (level: ThinkingLevel) => void;
} {
  const [remembered, setRemembered] = useState<DraftModelPick>(() => {
    const stored = readDraftPick(view.models);
    const model: ModelRef | undefined =
      stored !== undefined
        ? { provider: stored.provider, modelId: stored.modelId }
        : view.defaults.model ??
          (view.models[0] === undefined
            ? undefined
            : { provider: view.models[0].provider, modelId: view.models[0].modelId });
    const levels = summaryOf(view.models, model)?.thinkingLevels ?? ["off"];
    const want = (stored?.thinkingLevel ?? view.defaults.thinkingLevel ?? "off") as ThinkingLevel;
    return { model, level: clampLevel(levels, want) };
  });

  const remember = (model: ModelRef, level: ThinkingLevel): void => {
    localStorage.setItem(DRAFT_MODEL_KEY, JSON.stringify({ ...model, thinkingLevel: level }));
  };

  const model =
    remembered.model !== undefined && summaryOf(view.models, remembered.model) !== undefined
      ? remembered.model
      : summaryOf(view.models, view.defaults.model) !== undefined
        ? view.defaults.model
        : view.models[0] === undefined
          ? undefined
          : { provider: view.models[0].provider, modelId: view.models[0].modelId };
  const level = clampLevel(summaryOf(view.models, model)?.thinkingLevels ?? ["off"], remembered.level);

  return {
    pick: { model, level },
    setModel: (next) => {
      const nextLevel = clampLevel(summaryOf(view.models, next)?.thinkingLevels ?? ["off"], level);
      setRemembered({ model: next, level: nextLevel });
      remember(next, nextLevel);
    },
    setLevel: (next) => {
      setRemembered((current) => ({ ...current, level: next }));
      if (model !== undefined) remember(model, next);
    },
  };
}
