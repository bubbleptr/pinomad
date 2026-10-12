// The draft screen's model+level pick, mirroring the web hook's API. Where
// the web persists to localStorage, this keeps the remembered pick in a
// module variable: it survives navigating away and back, resets on app
// restart (there's no AsyncStorage in this app and we're not adding one).
import { useState } from "react";
import type { ModelRef } from "@earendil-works/pi-durable";
import type { DurableView, ThinkingLevel } from "@pinomad/protocol/view.ts";
import { clampLevel, reconcileDraftPick, summaryOf, type ModelPick } from "@pinomad/client/model.ts";

let remembered: ModelPick | undefined;

export function useDraftModelPick(view: DurableView): {
  pick: ModelPick;
  setModel: (model: ModelRef) => void;
  setLevel: (level: ThinkingLevel) => void;
} {
  const [current, setCurrent] = useState<ModelPick>(
    () => remembered ?? { model: view.defaults.model, level: view.defaults.thinkingLevel ?? "off" },
  );
  const set = (pick: ModelPick): void => {
    remembered = pick;
    setCurrent(pick);
  };

  const pick = reconcileDraftPick(view.models, view.defaults, current);
  return {
    pick,
    setModel: (next) => {
      const level = clampLevel(summaryOf(view.models, next)?.thinkingLevels ?? ["off"], pick.level);
      set({ model: next, level });
    },
    setLevel: (next) => {
      set({ model: pick.model, level: next });
    },
  };
}
