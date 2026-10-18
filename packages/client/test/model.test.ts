import { describe, expect, it } from "vitest";
import { clampLevel, filterModels, modelLabel, reconcileDraftPick, resolveAgentDraft, sameModel } from "../src/model.ts";
import {
  AGENT_DRAFT_CASES,
  CLAMP_CASES,
  FILTER_CASES,
  MODEL_LABEL_CASES,
  RECONCILE_CASES,
  SAME_MODEL_CASES,
} from "./models-cases.ts";

const C = <T extends { name: string }[]>(cases: T, name: string): T[number] =>
  cases.find((c) => c.name === name) as T[number];

describe("clampLevel", () => {
  it("keeps the level when the model supports it", () => {
    expect(clampLevel(C(CLAMP_CASES, "supported").levels, "high")).toBe("high");
    expect(clampLevel(C(CLAMP_CASES, "exact-off").levels, "off")).toBe("off");
  });

  it("clamps down to the highest supported level below the wanted one", () => {
    expect(clampLevel(C(CLAMP_CASES, "clamps-down").levels, "xhigh")).toBe("medium");
    expect(clampLevel(C(CLAMP_CASES, "skips-unsupported-middle").levels, "high")).toBe("medium");
  });

  it("falls back to off when nothing supported is below the wanted level", () => {
    expect(clampLevel(C(CLAMP_CASES, "nothing-below").levels, "off")).toBe("off");
    expect(clampLevel(C(CLAMP_CASES, "empty-levels").levels, "medium")).toBe("off");
  });
});

describe("modelLabel", () => {
  it("appends the level label for a reasoning model", () => {
    const c = C(MODEL_LABEL_CASES, "reasoning");
    expect(modelLabel(c.models, c.selected)).toBe("GPT B · Low");
  });

  it("is just the name when the model does not reason", () => {
    const c = C(MODEL_LABEL_CASES, "non-reasoning");
    expect(modelLabel(c.models, c.selected)).toBe("Llama C");
  });

  it("names an unlisted ref by its modelId and no model at all as No model", () => {
    const unlisted = C(MODEL_LABEL_CASES, "unlisted-model");
    expect(modelLabel(unlisted.models, unlisted.selected)).toBe("claude-z");
    const none = C(MODEL_LABEL_CASES, "no-model");
    expect(modelLabel(none.models, none.selected)).toBe("No model");
  });
});

describe("filterModels", () => {
  const filtered = (name: string) => {
    const c = C(FILTER_CASES, name);
    return filterModels(c.models, c.query).map((m) => m.modelId);
  };

  it("returns all models for a blank query", () => {
    expect(filtered("blank-query")).toEqual(["claude-a", "gpt-b", "llama-c"]);
  });

  it("matches name or provider/modelId case-insensitively", () => {
    expect(filtered("name-substring")).toEqual(["claude-a"]);
    expect(filtered("case-insensitive")).toEqual(["claude-a"]);
    expect(filtered("provider-modelid")).toEqual(["gpt-b"]);
    expect(filtered("trims")).toEqual(["gpt-b"]);
    expect(filtered("no-match")).toEqual([]);
  });
});

describe("sameModel", () => {
  it("compares provider and modelId with both sides defined", () => {
    expect(sameModel(C(SAME_MODEL_CASES, "same").a, C(SAME_MODEL_CASES, "same").b)).toBe(true);
    expect(sameModel(C(SAME_MODEL_CASES, "different-provider").a, C(SAME_MODEL_CASES, "different-provider").b)).toBe(
      false,
    );
    expect(sameModel(C(SAME_MODEL_CASES, "different-id").a, C(SAME_MODEL_CASES, "different-id").b)).toBe(false);
    expect(sameModel(C(SAME_MODEL_CASES, "a-absent").a, C(SAME_MODEL_CASES, "a-absent").b)).toBe(false);
    expect(sameModel(C(SAME_MODEL_CASES, "both-absent").a, C(SAME_MODEL_CASES, "both-absent").b)).toBe(false);
  });
});

describe("reconcileDraftPick", () => {
  const pick = (name: string) => {
    const c = C(RECONCILE_CASES, name);
    return reconcileDraftPick(c.models, c.defaults, c.remembered);
  };

  it("keeps the remembered model while it is still listed", () => {
    const result = pick("remembered-listed");
    expect(result.model).toEqual({ provider: "anthropic", modelId: "claude-a" });
    expect(result.level).toBe("high");
  });

  it("falls back to the host default when the remembered model left the list", () => {
    const result = pick("default-fallback");
    expect(result.model).toEqual({ provider: "openai", modelId: "gpt-b" });
  });

  it("falls back to the first listed model when the host default is unlisted too", () => {
    const result = pick("first-fallback");
    expect(result.model).toEqual({ provider: "anthropic", modelId: "claude-a" });
  });

  it("returns no model and off for an empty model list", () => {
    const result = pick("empty-list");
    expect(result.model).toBeUndefined();
    expect(result.level).toBe("off");
  });

  it("clamps the remembered level to the resolved model's levels", () => {
    expect(pick("clamps-remembered").level).toBe("medium");
    const fellBack = pick("clamps-after-fallback");
    expect(fellBack.model).toEqual({ provider: "openai", modelId: "gpt-b" });
    expect(fellBack.level).toBe("medium");
  });
});

describe("resolveAgentDraft", () => {
  const resolve = (name: string) => {
    const c = C(AGENT_DRAFT_CASES, name);
    return resolveAgentDraft(c.agent, c.agents, c.models, c.defaults, c.overrides);
  };

  it("inherits the role's pins and sends only the agent name", () => {
    const result = resolve("inherit-pins");
    expect(result.model).toEqual({ provider: "anthropic", modelId: "claude-a" });
    expect(result.level).toBe("high");
    expect(result.modelFrom).toBe("agent");
    expect(result.levelFrom).toBe("agent");
    expect(result.send).toEqual({ agent: "reviewer" });
    expect(result.problem).toBeUndefined();
  });

  it("falls through unpinned fields to the host defaults", () => {
    const result = resolve("inherit-defaults");
    expect(result.model).toEqual({ provider: "openai", modelId: "gpt-b" });
    expect(result.level).toBe("low");
    expect(result.modelFrom).toBe("default");
    expect(result.levelFrom).toBe("default");
    expect(result.send).toEqual({ agent: "planner" });
  });

  it("sends an overridden model and clamps an inherited level to it", () => {
    const result = resolve("override-model-clamps-inherited");
    expect(result.model).toEqual({ provider: "openai", modelId: "gpt-b" });
    // The role's "high" does not survive the pick — gpt-b tops out at medium.
    expect(result.level).toBe("medium");
    expect(result.modelFrom).toBe("override");
    expect(result.levelFrom).toBe("agent");
    expect(result.send).toEqual({ agent: "reviewer", model: { provider: "openai", modelId: "gpt-b" } });
    expect(result.problem).toBeUndefined();
  });

  it("sends an overridden level clamped to the inherited model", () => {
    const result = resolve("override-level");
    expect(result.level).toBe("high");
    expect(result.levelFrom).toBe("override");
    expect(result.send).toEqual({ agent: "reviewer", thinkingLevel: "xhigh" });
  });

  it("flags an unadvertised role model instead of falling back", () => {
    const result = resolve("role-model-unavailable");
    expect(result.problem).toEqual({
      kind: "model-unavailable",
      agent: "reviewer",
      model: { provider: "gone", modelId: "claude-z" },
      source: "agent",
    });
    // The failed model still shows — the capsule explains what would be sent.
    expect(result.model).toEqual({ provider: "gone", modelId: "claude-z" });
    expect(result.level).toBe("high");
  });

  it("clears the model problem once the user picks an available model", () => {
    const result = resolve("override-fixes-unavailable");
    expect(result.problem).toBeUndefined();
    expect(result.send).toEqual({ agent: "reviewer", model: { provider: "openai", modelId: "gpt-b" } });
  });

  it("flags the source layer of an unavailable default and of a bad override", () => {
    expect(resolve("default-model-unavailable").problem).toMatchObject({
      kind: "model-unavailable",
      source: "default",
    });
    expect(resolve("override-model-unavailable").problem).toMatchObject({
      kind: "model-unavailable",
      source: "override",
    });
  });

  it("flags a name that is not in the snapshot, with the file's load reason", () => {
    expect(resolve("agent-missing").problem).toEqual({
      kind: "agent-missing",
      agent: "ghost",
      reason: "unknown field 'tools'",
    });
    expect(resolve("agents-null").problem).toEqual({ kind: "agent-missing", agent: "ghost" });
  });

  it("flags a draft with no resolvable model", () => {
    const result = resolve("model-missing");
    expect(result.model).toBeUndefined();
    expect(result.problem).toEqual({ kind: "model-missing", agent: "planner" });
  });
});
