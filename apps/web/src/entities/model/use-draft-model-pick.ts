import type { ModelRef } from "@earendil-works/pi-durable";
import { useState } from "react";
import type { DurableView, ModelSummary, ThinkingLevel } from "@pinomad/protocol/view.ts";
import { clampLevel, reconcileDraftPick, summaryOf } from "@pinomad/client/model.ts";

const DRAFT_MODEL_KEY = "pinomad.draft.model";

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

  const pick = reconcileDraftPick(view.models, view.defaults, remembered);
  const level = pick.level;

  return {
    pick,
    setModel: (next) => {
      const nextLevel = clampLevel(summaryOf(view.models, next)?.thinkingLevels ?? ["off"], level);
      setRemembered({ model: next, level: nextLevel });
      remember(next, nextLevel);
    },
    setLevel: (next) => {
      setRemembered((current) => ({ ...current, level: next }));
      if (pick.model !== undefined) remember(pick.model, next);
    },
  };
}
