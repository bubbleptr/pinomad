import { describe, expect, it } from "vitest";
import type { ModelRef } from "@earendil-works/pi-durable";
import type { ConversationDefaults, ModelSummary } from "@pinomad/protocol/view.ts";
import { clampLevel, reconcileDraftPick } from "../src/model.ts";

const model = (over: Partial<ModelSummary> = {}): ModelSummary => ({
  provider: "anthropic",
  modelId: "claude-x",
  name: "Claude X",
  contextWindow: 200_000,
  thinkingLevels: ["off"],
  ...over,
});

const models = {
  a: model({ provider: "anthropic", modelId: "claude-a", name: "Claude A", thinkingLevels: ["off", "medium", "high"] }),
  b: model({ provider: "openai", modelId: "gpt-b", name: "GPT B", thinkingLevels: ["off", "low", "medium"] }),
  c: model({ provider: "local", modelId: "llama-c", name: "Llama C" }),
};

const ref = (m: ModelSummary): ModelRef => ({ provider: m.provider, modelId: m.modelId });
const defaults = (over: Partial<ConversationDefaults> = {}): ConversationDefaults => over;

describe("clampLevel", () => {
  it("keeps the level when the model supports it", () => {
    expect(clampLevel(["off", "low", "high"], "high")).toBe("high");
    expect(clampLevel(["off"], "off")).toBe("off");
  });

  it("clamps down to the highest supported level below the wanted one", () => {
    expect(clampLevel(["off", "low", "medium"], "xhigh")).toBe("medium");
    expect(clampLevel(["off", "medium"], "high")).toBe("medium");
  });

  it("falls back to off when nothing supported is below the wanted level", () => {
    expect(clampLevel(["high", "max"], "off")).toBe("off");
    expect(clampLevel([], "medium")).toBe("off");
  });
});

describe("reconcileDraftPick", () => {
  const list = [models.a, models.b];

  it("keeps the remembered model while it is still listed", () => {
    const pick = reconcileDraftPick(list, defaults({ model: ref(models.b) }), {
      model: ref(models.a),
      level: "high",
    });
    expect(pick.model).toEqual(ref(models.a));
    expect(pick.level).toBe("high");
  });

  it("falls back to the host default when the remembered model left the list", () => {
    const pick = reconcileDraftPick(list, defaults({ model: ref(models.b) }), {
      model: { provider: "gone", modelId: "claude-z" },
      level: "low",
    });
    expect(pick.model).toEqual(ref(models.b));
  });

  it("falls back to the first listed model when the host default is unlisted too", () => {
    const pick = reconcileDraftPick(list, defaults({ model: { provider: "gone", modelId: "claude-z" } }), {
      model: { provider: "gone", modelId: "also-gone" },
      level: "off",
    });
    expect(pick.model).toEqual(ref(models.a));
  });

  it("returns no model and off for an empty model list", () => {
    const pick = reconcileDraftPick([], defaults(), { model: ref(models.a), level: "high" });
    expect(pick.model).toBeUndefined();
    expect(pick.level).toBe("off");
  });

  it("clamps the remembered level to the resolved model's levels", () => {
    // "high" remembered for a model that only reaches "medium" -> "medium".
    const pick = reconcileDraftPick(list, defaults(), { model: ref(models.b), level: "high" });
    expect(pick.model).toEqual(ref(models.b));
    expect(pick.level).toBe("medium");
    // Falling back to a model whose levels differ re-clamps.
    const fellBack = reconcileDraftPick(list, defaults({ model: ref(models.b) }), {
      model: { provider: "gone", modelId: "claude-z" },
      level: "high",
    });
    expect(fellBack.model).toEqual(ref(models.b));
    expect(fellBack.level).toBe("medium");
  });
});
