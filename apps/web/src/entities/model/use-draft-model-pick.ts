import type { ModelRef } from "@earendil-works/pi-durable";
import { useState } from "react";
import type { DurableView, ModelSummary, ThinkingLevel } from "@pinomad/protocol/view.ts";
import {
  clampLevel,
  reconcileDraftPick,
  resolveAgentDraft,
  summaryOf,
  type AgentDraftOverrides,
  type AgentDraftResolution,
} from "@pinomad/client/model.ts";

const DRAFT_MODEL_KEY = "pinomad.draft.model";

/** Each host keeps its own draft pick: model ids and defaults differ per host. */
export function draftModelKey(hostKey: string | undefined): string {
  return hostKey === undefined ? DRAFT_MODEL_KEY : `${DRAFT_MODEL_KEY}.${hostKey}`;
}

interface DraftPick {
  readonly provider: string;
  readonly modelId: string;
  readonly thinkingLevel: string;
}

/** The last draft pick for this host, only when its model is still listed. */
function readDraftPick(models: readonly ModelSummary[], hostKey: string | undefined): DraftPick | undefined {
  try {
    const raw = localStorage.getItem(draftModelKey(hostKey));
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
 *
 * With a named agent picked (ADR-0023), the pick comes from
 * `resolveAgentDraft` instead: each side is "inherited" (role pin or host
 * default, resolved host-side at create) until the user touches it, which
 * turns that side into an override sent with the call. Overrides never write
 * the remembered pick — clearing the agent returns to it untouched, and
 * picking another agent drops the overrides back to full inheritance.
 */
export function useDraftModelPick(view: DurableView, hostKey?: string): {
  pick: DraftModelPick;
  setModel: (model: ModelRef) => void;
  setLevel: (level: ThinkingLevel) => void;
  agent?: string;
  setAgent: (agent: string | undefined) => void;
  /** The inherit/override resolution while an agent is picked — undefined otherwise. */
  resolution?: AgentDraftResolution;
} {
  const [remembered, setRemembered] = useState<DraftModelPick>(() => {
    const stored = readDraftPick(view.models, hostKey);
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
  const [agent, setAgentState] = useState<string | undefined>(undefined);
  const [overrides, setOverrides] = useState<AgentDraftOverrides>({});

  const remember = (model: ModelRef, level: ThinkingLevel): void => {
    localStorage.setItem(draftModelKey(hostKey), JSON.stringify({ ...model, thinkingLevel: level }));
  };

  const resolution =
    agent === undefined ? undefined : resolveAgentDraft(agent, view.agents, view.models, view.defaults, overrides);
  const reconciled = reconcileDraftPick(view.models, view.defaults, remembered);
  const pick: DraftModelPick = resolution ?? reconciled;
  const level = pick.level;

  return {
    pick,
    agent,
    resolution,
    setModel: (next) => {
      if (agent !== undefined) {
        setOverrides((current) => ({ ...current, model: next }));
        return;
      }
      const nextLevel = clampLevel(summaryOf(view.models, next)?.thinkingLevels ?? ["off"], level);
      setRemembered({ model: next, level: nextLevel });
      remember(next, nextLevel);
    },
    setLevel: (next) => {
      if (agent !== undefined) {
        setOverrides((current) => ({ ...current, level: next }));
        return;
      }
      setRemembered((current) => ({ ...current, level: next }));
      if (pick.model !== undefined) remember(pick.model, next);
    },
    setAgent: (next) => {
      setAgentState(next);
      // Switching to another agent or clearing one starts from full
      // inheritance again — the overrides belonged to the previous pick.
      setOverrides({});
    },
  };
}
