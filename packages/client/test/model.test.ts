import { describe, expect, it } from "vitest";
import { clampLevel, filterModels, modelLabel, reconcileDraftPick, sameModel } from "../src/model.ts";
import {
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
