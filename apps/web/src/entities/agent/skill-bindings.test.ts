// The composer's skill bindings (issue #308, ADR-0028): the draft is a plain
// string, and a `$` menu pick binds the `$name` it inserted. Bindings follow
// every edit; only bound names are sent as `skills`.
import { describe, expect, it } from "vitest";
import { draftMessage, followEdit, restoreDraft, type SkillDraft } from "./skill-bindings.ts";

const bound = (text: string, ...bindings: [number, string][]): SkillDraft => ({
  text,
  bindings: bindings.map(([start, name]) => ({ start, end: start + 1 + name.length, name })),
});
const spans = (draft: SkillDraft): string[] => draft.bindings.map((b) => `${b.start}:${draft.text.slice(b.start, b.end)}`);

describe("followEdit", () => {
  it("binds the $name a pick inserted over the typed query", () => {
    expect(spans(followEdit(bound("please $rev"), "please $review ", "review"))).toEqual(["7:$review"]);
    // Mid-sentence: Astryx replaces `$rev` in place, the rest of the line stays.
    expect(spans(followEdit(bound("please $rev the code"), "please $review  the code", "review"))).toEqual(["7:$review"]);
    // An empty query, and a query that already spelled the whole name.
    expect(spans(followEdit(bound("please $"), "please $review ", "review"))).toEqual(["7:$review"]);
    expect(spans(followEdit(bound("please $review"), "please $review ", "review"))).toEqual(["7:$review"]);
  });

  it("binds only the picked occurrence, never an identical typed one", () => {
    const next = followEdit(bound('not "$review" but $'), 'not "$review" but $review ', "review");
    expect(spans(next)).toEqual(["18:$review"]);
  });

  it("binds nothing when the pick didn't land as $name", () => {
    expect(followEdit(bound("please $rev"), "please $rev!", "review").bindings).toEqual([]);
  });

  it("shifts bindings clear of the edit", () => {
    const draft = bound("run $review now", [4, "review"]);
    expect(spans(followEdit(draft, "please run $review now"))).toEqual(["11:$review"]);
    expect(spans(followEdit(draft, "run $review now, please"))).toEqual(["4:$review"]);
  });

  it("keeps a binding an edit only touches at its edge while $name still reads intact", () => {
    const draft = bound("run $review now", [4, "review"]);
    expect(spans(followEdit(draft, "run $reviewx now"))).toEqual(["4:$review"]);
    expect(spans(followEdit(draft, "run x$review now"))).toEqual(["5:$review"]);
  });

  it("unbinds a binding the edit cut into", () => {
    const draft = bound("run $review now", [4, "review"]);
    expect(followEdit(draft, "run $revXiew now").bindings).toEqual([]);
    expect(followEdit(draft, "run $revie now").bindings).toEqual([]);
    expect(followEdit(draft, "run  now").bindings).toEqual([]);
    expect(followEdit(draft, "").bindings).toEqual([]);
  });

  it("follows several bindings through one edit", () => {
    const draft = bound("$a and $b and $c", [0, "a"], [7, "b"], [14, "c"]);
    expect(spans(followEdit(draft, "$a or $b and $c"))).toEqual(["0:$a", "6:$b", "13:$c"]);
    expect(spans(followEdit(draft, "$a and $X and $c"))).toEqual(["0:$a", "14:$c"]);
  });
});

describe("restoreDraft", () => {
  it("binds the lexical mentions of the skills the message expanded", () => {
    const draft = restoreDraft('check $review, not "$review" or $deploy', ["review"]);
    expect(draft.text).toBe('check $review, not "$review" or $deploy');
    expect(spans(draft)).toEqual(["6:$review"]);
  });

  it("binds nothing without skills", () => {
    expect(restoreDraft("check $review", []).bindings).toEqual([]);
  });
});

describe("draftMessage", () => {
  it("sends the text as is with the bound names deduplicated in text order", () => {
    const draft = bound("use $b, then $a and $b again", [4, "b"], [13, "a"], [20, "b"]);
    expect(draftMessage(draft)).toEqual({ text: "use $b, then $a and $b again", skills: ["b", "a"] });
  });

  it("sends no skills for a typed $name", () => {
    expect(draftMessage(bound('please "$review" it'))).toEqual({ text: 'please "$review" it', skills: [] });
  });

  it("keeps a bound $name apart from glued word characters so the bubble finds it", () => {
    expect(draftMessage(bound("x$review", [1, "review"])).text).toBe("x $review");
    expect(draftMessage(bound("$reviewx", [0, "review"])).text).toBe("$review x");
    expect(draftMessage(bound("$review$deploy", [0, "review"])).text).toBe("$review $deploy");
    expect(draftMessage(bound("$review_it", [0, "review"])).text).toBe("$review _it");
    // Punctuation after the name doesn't continue it.
    expect(draftMessage(bound("$review, then", [0, "review"])).text).toBe("$review, then");
  });
});
