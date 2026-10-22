// Image refs (issue #167, ADR-0027): a conversation stream can carry image
// blocks by reference. The invariant under test is that a client applying the
// rewritten ops to the rewritten snapshot ends with the rewrite of the real view.
import { createHash } from "node:crypto";
import type { JsonValue } from "@earendil-works/chord";
import { applyImmutable, type Op } from "@earendil-works/chord/delta";
import { describe, expect, it } from "vitest";
import { ImageRefs } from "../src/image-refs.ts";

const image = (data: string, mimeType = "image/png") => ({ type: "image", data, mimeType });
const userView = (...content: JsonValue[]): JsonValue => ({
  entries: [{ id: "1", kind: "pi.user", model: [{ role: "user", content }] }],
  docs: {},
});
const inboxView = (content: JsonValue): JsonValue => ({
  entries: [],
  docs: { "pi.inbox": { items: [{ id: 1, content }] } },
});
const liveView = (content: JsonValue[]): JsonValue => ({
  entries: [],
  docs: { "pi.live": { generation: { message: { role: "assistant", content } } } },
});
const refIn = (block: JsonValue): string => (block as { ref: string }).ref;

/** Feed `ops` through a fresh ImageRefs the way the gateway does and check both sides agree. */
async function roundTrip(before: JsonValue, ops: readonly Op[]) {
  const refs = new ImageRefs();
  const shown = await refs.value(before);
  const after = applyImmutable(before, ops) as JsonValue;
  const sent = await refs.ops(ops, before);
  expect(applyImmutable(shown, sent)).toEqual(await refs.value(after));
  return { refs, shown, sent, after };
}

describe("ImageRefs", () => {
  it("swaps image bytes for a content ref and answers the bytes back", async () => {
    const refs = new ImageRefs();
    const before = userView({ type: "text", text: "look" }, image("aGVsbG8="));
    const shown = await refs.value(before) as {
      entries: [{ model: [{ content: [JsonValue, { ref: string }] }] }];
    };
    const block = shown.entries[0].model[0].content[1];
    expect(block).toEqual({ type: "image", mimeType: "image/png", ref: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(refs.image(before, block.ref)).toEqual({ data: "aGVsbG8=", mimeType: "image/png" });
    expect(refs.image(before, "missing")).toBeUndefined();
  });

  it("binds a ref to both the mime type and the bytes", async () => {
    const refs = new ImageRefs();
    const png = await refs.value(userView(image("AAAA"))) as { entries: [{ model: [{ content: [{ ref: string }] }] }] };
    const jpeg = await refs.value(userView(image("AAAA", "image/jpeg"))) as { entries: [{ model: [{ content: [{ ref: string }] }] }] };
    expect(refIn(png.entries[0].model[0].content[0])).toBe(
      createHash("sha256").update("image/png\nAAAA").digest("hex"),
    );
    expect(refIn(jpeg.entries[0].model[0].content[0])).not.toBe(refIn(png.entries[0].model[0].content[0]));
  });

  it("gives equal images equal refs at every rewrite position", async () => {
    const refs = new ImageRefs();
    const first = await refs.value(userView(image("AAAA"))) as { entries: [{ model: [{ content: [{ ref: string }] }] }] };
    const second = await refs.value(inboxView([image("AAAA")])) as { docs: { "pi.inbox": { items: [{ content: [{ ref: string }] }] } } };
    const third = await refs.value(liveView([image("AAAA")])) as { docs: { "pi.live": { generation: { message: { content: [{ ref: string }] } } } } };
    const ref = refIn(first.entries[0].model[0].content[0]);
    expect(refIn(second.docs["pi.inbox"].items[0].content[0])).toBe(ref);
    expect(refIn(third.docs["pi.live"].generation.message.content[0])).toBe(ref);
  });

  it("rewrites only the three known content positions", async () => {
    const details = image("RElFVEFJTFM=");
    const argument = image("QVJHVU1FTlQ=");
    const view: JsonValue = {
      entries: [
        {
          id: "1",
          kind: "pi.tool-result",
          model: [
            {
              role: "toolResult",
              toolCallId: "call:1",
              content: [{ type: "text", text: "read" }, image("RU5UUlk=")],
              details: { image: details },
            },
            {
              role: "assistant",
              content: [{ type: "toolCall", id: "call:1", name: "read", arguments: { image: argument } }],
            },
          ],
        },
      ],
      docs: {
        "pi.inbox": { items: [{ id: 1, content: [{ type: "text", text: "queued" }, image("SU5CT1g=")] }] },
        "pi.live": { generation: { message: { role: "assistant", content: [image("TElWRQ==")] } } },
        other: { items: [{ content: [image("T1RIRVI=")] }] },
      },
    };
    const shown = await new ImageRefs().value(view) as {
      entries: [{ model: [{ content: [JsonValue, JsonValue]; details: { image: JsonValue } }, { content: [{ arguments: { image: JsonValue } }] }] }];
      docs: {
        "pi.inbox": { items: [{ content: [JsonValue, JsonValue] }] };
        "pi.live": { generation: { message: { content: [JsonValue] } } };
        other: { items: [{ content: [JsonValue] }] };
      };
    };
    expect(shown.entries[0].model[0].content[1]).toEqual({ type: "image", mimeType: "image/png", ref: expect.any(String) });
    expect(shown.entries[0].model[0].details.image).toEqual(details);
    expect(shown.entries[0].model[1].content[0].arguments.image).toEqual(argument);
    expect(shown.docs["pi.inbox"].items[0].content[1]).toEqual({ type: "image", mimeType: "image/png", ref: expect.any(String) });
    expect(shown.docs["pi.live"].generation.message.content[0]).toEqual({ type: "image", mimeType: "image/png", ref: expect.any(String) });
    expect(shown.docs.other.items[0].content[0]).toEqual(image("T1RIRVI="));
    expect(JSON.stringify(shown)).not.toContain("RU5UUlk=");
    expect(JSON.stringify(shown)).not.toContain("SU5CT1g=");
    expect(JSON.stringify(shown)).not.toContain("TElWRQ==");
  });

  it("leaves a view without images untouched, identity included", async () => {
    const value = userView({ type: "text", text: "hi" });
    expect(await new ImageRefs().value(value)).toBe(value);
  });

  it("rewrites images inside set, splice and replace payloads", async () => {
    const before = userView({ type: "text", text: "hi" });
    const set = await roundTrip(before, [["s", ["entries", 0, "model", 0, "content", 1], image("AAAA")]]);
    expect(JSON.stringify(set.sent)).toContain('"ref"');
    expect(JSON.stringify(set.sent)).not.toContain("AAAA");
    await roundTrip(before, [["p", ["entries"], 1, 0, [{ id: "2", model: [{ content: [image("BBBB")] }] }]]]);
    const { sent } = await roundTrip(before, [["r", userView(image("CCCC"))]]);
    expect(JSON.stringify(sent)).not.toContain("CCCC");

    await roundTrip(inboxView("queued"), [["s", ["docs", "pi.inbox"], { items: [{ id: 1, content: [image("DDDD")] }] }]]);
    await roundTrip(liveView([]), [["s", ["docs", "pi.live"], { generation: { message: { content: [image("EEEE")] } } }]]);
  });

  it("keeps pseudo images in tool details and arguments out of ops payloads", async () => {
    const before = userView({ type: "text", text: "hi" });
    const entry = {
      id: "2",
      model: [{ role: "toolResult", content: [image("AAAA")], details: { image: image("RElFVEFJTFM=") } }],
    };
    const { sent } = await roundTrip(before, [["p", ["entries"], 1, 0, [entry]]]);
    expect(JSON.stringify(sent)).not.toContain("AAAA");
    expect(JSON.stringify(sent)).toContain("RElFVEFJTFM=");
  });

  it("keeps text streaming ops as they are", async () => {
    const before = userView({ type: "text", text: "he" }, image("AAAA"));
    const ops: Op[] = [["a", ["entries", 0, "model", 0, "content", 0, "text"], "llo"]];
    expect((await roundTrip(before, ops)).sent).toEqual(ops);
  });

  it("replaces the whole value when an op reaches inside an image block", async () => {
    // The client holds a ref where the bytes were, so an op on the bytes can't apply.
    const before = userView(image("AAAA"));
    const { sent, refs, after } = await roundTrip(before, [["a", ["entries", 0, "model", 0, "content", 0, "data"], "BBBB"]]);
    expect(sent).toEqual([["r", await refs.value(after)]]);
    await roundTrip(before, [["d", ["entries", 0, "model", 0, "content", 0, "data"]]]);
    await roundTrip(userView({ type: "text", text: "x" }), [
      ["s", ["entries", 0, "model", 0, "content", 1], image("AAAA")],
      ["s", ["entries", 0, "model", 0, "content", 1, "mimeType"], "image/jpeg"],
    ]);
  });

  it("tracks intermediate state across a batch (chord 1.2.0 counterexample)", async () => {
    const before = userView({ type: "text", text: "x" });
    const content = ["entries", 0, "model", 0, "content"] as const;
    const ops: Op[] = [
      ["p", content, 1, 0, [image("AAAA")]],
      ["a", [...content, 1, "data"] as const, "X"],
      ["p", content, 0, 1, []],
    ];
    const { sent } = await roundTrip(before, ops);
    // The batch would apply to the bytes, but the client only holds a ref:
    // replace the finished view once instead.
    expect(sent).toHaveLength(1);
    expect(sent[0]![0]).toBe("r");
  });

  it("resolves a ref only while the current view still shows it", async () => {
    const before = userView({ type: "text", text: "x" }, image("AAAA"));
    const shown = await new ImageRefs().value(before) as { entries: [{ model: [{ content: [JsonValue, { ref: string }] }] }] };
    const ref = refIn(shown.entries[0].model[0].content[1]);
    expect(new ImageRefs().image(before, ref)?.data).toBe("AAAA");
    const after = applyImmutable(before, [["p", ["entries", 0, "model", 0, "content"], 1, 1, []]]) as JsonValue;
    expect(new ImageRefs().image(after, ref)).toBeUndefined();
  });
});
