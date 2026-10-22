// Image refs (issue #167, ADR-0027): a conversation stream can carry image
// blocks by reference. The invariant under test is that a client applying the
// rewritten ops to the rewritten snapshot ends with the rewrite of the real view.
import type { JsonValue } from "@earendil-works/chord";
import { applyImmutable, type Op } from "@earendil-works/chord/delta";
import { describe, expect, it } from "vitest";
import { ImageRefs } from "../src/image-refs.ts";

const image = (data: string) => ({ type: "image", data, mimeType: "image/png" });
const view = (...content: JsonValue[]): JsonValue => ({ entries: [{ id: "1", content }], docs: {} });

/** Feed `ops` through a fresh ImageRefs the way the gateway does and check both sides agree. */
function roundTrip(before: JsonValue, ops: readonly Op[]) {
  const refs = new ImageRefs();
  const shown = refs.value(before);
  const after = applyImmutable(before, ops) as JsonValue;
  const sent = refs.ops(ops, before, after);
  expect(applyImmutable(shown, sent)).toEqual(refs.value(after));
  return { refs, shown, sent, after };
}

describe("ImageRefs", () => {
  it("swaps image bytes for a content ref and answers the bytes back", () => {
    const refs = new ImageRefs();
    const shown = refs.value(view({ type: "text", text: "look" }, image("aGVsbG8="))) as {
      entries: [{ content: [JsonValue, { ref: string }] }];
    };
    const block = shown.entries[0].content[1];
    expect(block).toEqual({ type: "image", mimeType: "image/png", ref: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(refs.get(block.ref)).toEqual({ data: "aGVsbG8=", mimeType: "image/png" });
    expect(refs.get("missing")).toBeUndefined();
  });

  it("gives equal images equal refs, wherever they appear", () => {
    const refs = new ImageRefs();
    const shown = refs.value({ a: image("AAAA"), b: [image("AAAA")], c: image("BBBB") }) as Record<string, { ref: string } | { ref: string }[]>;
    const a = (shown.a as { ref: string }).ref;
    expect((shown.b as { ref: string }[])[0]!.ref).toBe(a);
    expect((shown.c as { ref: string }).ref).not.toBe(a);
  });

  it("leaves a view without images untouched, identity included", () => {
    const value = view({ type: "text", text: "hi" });
    expect(new ImageRefs().value(value)).toBe(value);
  });

  it("rewrites images inside set, splice and replace payloads", () => {
    const before = view({ type: "text", text: "hi" });
    roundTrip(before, [["s", ["entries", 0, "content", 1], image("AAAA")]]);
    roundTrip(before, [["p", ["entries"], 1, 0, [{ id: "2", content: [image("BBBB")] }]]]);
    const { sent } = roundTrip(before, [["r", view(image("CCCC"))]]);
    expect(JSON.stringify(sent)).not.toContain("CCCC");
  });

  it("keeps text streaming ops as they are", () => {
    const before = view({ type: "text", text: "he" }, image("AAAA"));
    const ops: Op[] = [["a", ["entries", 0, "content", 0, "text"], "llo"]];
    expect(roundTrip(before, ops).sent).toEqual(ops);
  });

  it("replaces the whole value when an op reaches inside an image block", () => {
    // The client holds a ref where the bytes were, so an op on the bytes can't apply.
    const before = view(image("AAAA"));
    const { sent, refs, after } = roundTrip(before, [["a", ["entries", 0, "content", 0, "data"], "BBBB"]]);
    expect(sent).toEqual([["r", refs.value(after)]]);
    roundTrip(before, [["d", ["entries", 0, "content", 0, "data"]]]);
    roundTrip(view({ type: "text", text: "x" }), [
      ["s", ["entries", 0, "content", 1], image("AAAA")],
      ["s", ["entries", 0, "content", 1, "mimeType"], "image/jpeg"],
    ]);
  });

  it("forgets nothing it was shown while the subscription lives", () => {
    const refs = new ImageRefs();
    const first = refs.value(view(image("AAAA"))) as { entries: [{ content: [{ ref: string }] }] };
    refs.value(view(image("BBBB")));
    expect(refs.get(first.entries[0].content[0].ref)?.data).toBe("AAAA");
  });
});
