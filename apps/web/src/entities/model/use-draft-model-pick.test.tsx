import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { DurableView, ModelSummary, ThinkingLevel } from "@pinomad/protocol/view.ts";
import { draftModelKey, useDraftModelPick } from "./use-draft-model-pick.ts";

const model = (modelId: string, levels: ThinkingLevel[] = ["off"]): ModelSummary =>
  ({ provider: "faux", modelId, name: modelId, thinkingLevels: levels }) as unknown as ModelSummary;

const view = (models: ModelSummary[]): DurableView =>
  ({
    models,
    defaults: { model: undefined, thinkingLevel: "off" },
    agents: [],
  }) as unknown as DurableView;

beforeEach(() => localStorage.clear());

describe("draft model pick storage", () => {
  it("keeps a pick per host instead of one global entry", () => {
    const first = renderHook(() => useDraftModelPick(view([model("a"), model("b")]), "host-a"));
    act(() => first.result.current.setModel({ provider: "faux", modelId: "b" }));
    expect(JSON.parse(localStorage.getItem(draftModelKey("host-a"))!)).toMatchObject({ modelId: "b" });
    expect(localStorage.getItem(draftModelKey("host-b"))).toBeNull();
    first.unmount();

    const second = renderHook(() => useDraftModelPick(view([model("a"), model("b")]), "host-b"));
    expect(second.result.current.pick.model).toEqual({ provider: "faux", modelId: "a" });
  });

  it("moves an Off draft to the lowest level when the new model does not support Off", () => {
    const draft = renderHook(() =>
      useDraftModelPick(view([model("a"), model("b", ["low", "high"])]), "host-a")
    );
    expect(draft.result.current.pick.level).toBe("off");

    act(() => draft.result.current.setModel({ provider: "faux", modelId: "b" }));

    expect(draft.result.current.pick.model).toEqual({ provider: "faux", modelId: "b" });
    expect(draft.result.current.pick.level).toBe("low");
  });
});
