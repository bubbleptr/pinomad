import { describe, expect, it } from "vitest";
import type { ExtensionDocView } from "@pinomad/protocol/view.ts";
import { pendingQuestions, questionAnswers } from "../src/questions.ts";
import { ANSWER_CASES, PENDING_QUESTION_CASES } from "./misc-cases.ts";

const C = <T extends readonly { name: string }[]>(cases: T, name: string): T[number] =>
  cases.find((c) => c.name === name) as T[number];

describe("pendingQuestions", () => {
  it("excludes resolved requests and non-question docs", () => {
    const pending = pendingQuestions(C(PENDING_QUESTION_CASES, "mixed-docs").docs as unknown as ExtensionDocView[]);
    expect(pending.map((each) => each.request.id)).toEqual(["r2", "r3"]);
  });

  it("preserves order across docs and reports the doc kind", () => {
    const pending = pendingQuestions(C(PENDING_QUESTION_CASES, "doc-order").docs as unknown as ExtensionDocView[]);
    expect(pending.map((each) => each.request.id)).toEqual(["first", "second"]);
    expect(pending.map((each) => each.kind)).toEqual(["a", "question"]);
  });
});

describe("questionAnswers", () => {
  it("omits a blank other, keeps a non-blank one", () => {
    const c = C(ANSWER_CASES, "blank-and-custom");
    expect(questionAnswers(c.questionCount, [...c.selections], [...c.others])).toEqual([
      { selected: ["A"] },
      { selected: ["B"], other: "custom" },
    ]);
  });

  it("an untouched question answers with an empty selection", () => {
    const c = C(ANSWER_CASES, "untouched");
    expect(questionAnswers(c.questionCount, [...c.selections], [...c.others])).toEqual([
      { selected: [] },
      { selected: [] },
    ]);
  });
});
