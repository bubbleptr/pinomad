// Model + thinking-level derivations shared by every client (moved here from
// apps/web so the mobile app gets identical selector text, filtering and
// draft reconciliation). Plain data only — no DOM, no React, Hermes-safe.
import type { ModelRef } from "@earendil-works/pi-durable";
import type { AgentRoles } from "@pinomad/protocol/agents.ts";
import type { ConversationDefaults, DurableView, ModelSummary, ThinkingLevel } from "@pinomad/protocol/view.ts";

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

// ─── Named-agent drafts (ADR-0023) ─────────────────────────────────────────

/** Where a shown value came from: the role's pin, the host default, or the user's pick. */
export type AgentDraftSource = "agent" | "default" | "override";

/** The user's overrides on top of the selected agent; each side is optional. */
export interface AgentDraftOverrides {
  readonly model?: ModelRef;
  readonly level?: ThinkingLevel;
}

/** Why the host would refuse the create — checked before anything is sent. */
export type AgentDraftProblem =
  | {
      /** The name is not in the snapshot's roles (deleted, or its file failed to load — `reason` carries the load error). */
      readonly kind: "agent-missing";
      readonly agent: string;
      readonly reason?: string;
    }
  | {
      /** Nothing resolved to a model: no override, no role pin, no host default. */
      readonly kind: "model-missing";
      readonly agent: string;
    }
  | {
      /** The effective model — whichever source it came from — is not in the host's advertised list. */
      readonly kind: "model-unavailable";
      readonly agent: string;
      readonly model: ModelRef;
      readonly source: AgentDraftSource;
    };

export interface AgentDraftResolution {
  /** Display: the effective model; absent when none resolves (a `model-missing` problem). */
  readonly model?: ModelRef;
  /** Display: the effective level, clamped to the shown model only when it is listed — as the host does. */
  readonly level: ThinkingLevel;
  /** Which layer each shown value came from; `modelFrom` is absent when no model resolved. */
  readonly modelFrom?: AgentDraftSource;
  readonly levelFrom: AgentDraftSource;
  /** `createConversation` options: the agent name plus only the user's overrides — inherited values resolve host-side. */
  readonly send: {
    readonly agent: string;
    readonly model?: ModelRef;
    readonly thinkingLevel?: ThinkingLevel;
  };
  /** Why sending would fail at the host; the composer blocks submit on it. */
  readonly problem?: AgentDraftProblem;
}

/** `provider/modelId` → `ModelRef`, split on the first "/" exactly like the host's `roleModelRef`. */
const roleModelRef = (model: string): ModelRef => {
  const slash = model.indexOf("/");
  return { provider: model.slice(0, slash), modelId: model.slice(slash + 1) };
};

/**
 * The draft's model/level resolution once a named agent is picked: the same
 * chain the host runs at `createConversation` — override > role pin > host
 * default — so the capsule shows what the create would pick and refuses what
 * the host would reject. Unlike `reconcileDraftPick` there is no fallback to
 * the first listed model: an unresolvable pick is a problem, not a silent swap.
 */
export function resolveAgentDraft(
  agent: string,
  agents: AgentRoles | null,
  models: readonly ModelSummary[],
  defaults: ConversationDefaults,
  overrides: AgentDraftOverrides,
): AgentDraftResolution {
  const role = agents?.roles.find((each) => each.name === agent);
  const roleModel = role === undefined || role.model === undefined ? undefined : roleModelRef(role.model);
  const model = overrides.model ?? roleModel ?? defaults.model;
  const modelFrom: AgentDraftSource | undefined =
    overrides.model !== undefined
      ? "override"
      : roleModel !== undefined
        ? "agent"
        : defaults.model !== undefined
          ? "default"
          : undefined;
  const levelFrom: AgentDraftSource =
    overrides.level !== undefined ? "override" : role?.thinkingLevel !== undefined ? "agent" : "default";
  const want = overrides.level ?? role?.thinkingLevel ?? defaults.thinkingLevel ?? "off";
  const summary = summaryOf(models, model);
  // The host clamps only when the effective model resolves; an unlisted or
  // missing model leaves the inherited level untouched (the create fails anyway).
  const level = summary === undefined ? want : clampLevel(summary.thinkingLevels, want);
  const reason = agents?.problems.find((problem) => problem.file === `${agent}.md`)?.reason;
  const problem: AgentDraftProblem | undefined =
    role === undefined
      ? { kind: "agent-missing", agent, ...(reason === undefined ? {} : { reason }) }
      : model === undefined
        ? { kind: "model-missing", agent }
        : summary === undefined
          ? { kind: "model-unavailable", agent, model, source: modelFrom! }
          : undefined;
  return {
    ...(model === undefined ? {} : { model }),
    level,
    ...(modelFrom === undefined ? {} : { modelFrom }),
    levelFrom,
    send: {
      agent,
      ...(overrides.model === undefined ? {} : { model: overrides.model }),
      ...(overrides.level === undefined ? {} : { thinkingLevel: overrides.level }),
    },
    ...(problem === undefined ? {} : { problem }),
  };
}
