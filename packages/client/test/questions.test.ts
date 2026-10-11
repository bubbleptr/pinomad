import { describe, expect, it } from "vitest";
import type { ExtensionDocView } from "@pinomad/protocol/view.ts";
import { pendingQuestions, questionAnswers } from "../src/questions.ts";

const request = (id: string, resolution?: object) => ({
  id,
  askedAt: 1,
  questions: [{ header: "H", question: "Pick one", options: [{ label: "A" }, { label: "B" }] }],
  ...(resolution === undefined ? {} : { resolution }),
});

const doc = (value: object | null, presentation = "pinomad.question"): ExtensionDocView => ({
  kind: "question",
  presentation: presentation as ExtensionDocView["presentation"],
  value: value as ExtensionDocView["value"],
});

describe("pendingQuestions", () => {
  it("excludes resolved requests and non-question docs", () => {
    const docs = [
      doc({ requests: [request("r1", { outcome: "answered", answers: [], at: 1 }), request("r2")] }),
      { kind: "todo", presentation: undefined, value: { items: [] } } as ExtensionDocView,
      doc({ requests: [request("r3")] }),
    ];
    expect(pendingQuestions(docs).map((each) => each.request.id)).toEqual(["r2", "r3"]);
  });

  it("preserves order across docs and reports the doc kind", () => {
    const docs = [
      { kind: "a", presentation: "pinomad.question", value: { requests: [request("first")] } } as ExtensionDocView,
      doc({ requests: [request("second")] }),
    ];
    const pending = pendingQuestions(docs);
    expect(pending.map((each) => each.request.id)).toEqual(["first", "second"]);
    expect(pending.map((each) => each.kind)).toEqual(["a", "question"]);
  });
});

describe("questionAnswers", () => {
  it("omits a blank other, keeps a non-blank one", () => {
    expect(questionAnswers(2, [["A"], ["B"]], ["  ", "custom"])).toEqual([
      { selected: ["A"] },
      { selected: ["B"], other: "custom" },
    ]);
  });

  it("an untouched question answers with an empty selection", () => {
    expect(questionAnswers(2, [[], []], ["", ""])).toEqual([{ selected: [] }, { selected: [] }]);
  });
});
