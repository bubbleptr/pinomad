// Model + thinking-level derivations shared by every client (moved here from
// apps/web so the mobile app gets identical selector text, filtering and
// draft reconciliation). Plain data only — no DOM, no React, Hermes-safe.
import type { ModelRef } from "@earendil-works/pi-durable";
import type { DurableView, ModelSummary, ThinkingLevel } from "@pinomad/protocol/view.ts";

export const thinkingLevelLabels: Record<ThinkingLevel, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "X-High",
  max: "Max",
};

export const sameModel = (a: ModelRef | undefined, b: ModelRef | undefined): boolean =>
  a !== undefined && b !== undefined && a.provider === b.provider && a.modelId === b.modelId;

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

export interface ModelPick {
  readonly model?: ModelRef;
  readonly level: ThinkingLevel;
}

/** The selector trigger's text: "Name · Level" when the model reasons, else just the name. */
export function modelLabel(models: readonly ModelSummary[], selected: ModelPick): string {
  const summary = summaryOf(models, selected.model);
  const levels = summary?.thinkingLevels ?? ["off"];
  const name = summary?.name ?? selected.model?.modelId ?? "No model";
  return levels.length > 1 ? `${name} · ${thinkingLevelLabels[selected.level]}` : name;
}

/** Case-insensitive substring match on the display name or provider/modelId. */
export function filterModels(models: readonly ModelSummary[], query: string): readonly ModelSummary[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return models;
  return models.filter(
    (model) =>
      model.name.toLowerCase().includes(needle)
      || `${model.provider}/${model.modelId}`.toLowerCase().includes(needle),
  );
}

/**
 * Render-time reconciliation of a remembered draft pick against the models a
 * (re)connected host actually offers: remembered if still listed → the host
 * default → the first model → none; the level clamps to the resolved model.
 */
export function reconcileDraftPick(
  models: readonly ModelSummary[],
  defaults: DurableView["defaults"],
  remembered: ModelPick,
): ModelPick {
  const model =
    remembered.model !== undefined && summaryOf(models, remembered.model) !== undefined
      ? remembered.model
      : summaryOf(models, defaults.model) !== undefined
        ? defaults.model
        : models[0] === undefined
          ? undefined
          : { provider: models[0].provider, modelId: models[0].modelId };
  const level = clampLevel(summaryOf(models, model)?.thinkingLevels ?? ["off"], remembered.level);
  return { model, level };
}
