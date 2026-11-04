import { describe, expect, it } from "vitest";
import type { ConversationView, EntryId, EntryRecord } from "@earendil-works/pi-durable";
import { addEarlier, withEarlier } from "../src/transcript.ts";

const entry = (id: number): EntryRecord => ({ id: id as EntryId, kind: "pi.user" }) as EntryRecord;
const view = (ids: number[], before?: number): ConversationView =>
  ({ conversation: { id: 1 }, entries: ids.map(entry), docs: {}, ...(before === undefined ? {} : { before }) }) as unknown as ConversationView;
const ids = (shown: ConversationView): unknown[] => shown.entries.map((candidate) => candidate.id);

describe("earlier transcript pages", () => {
  it("shows loaded pages ahead of the window and takes the oldest page's before", () => {
    const window = view([20, 21], 18);
    let earlier = addEarlier(window, undefined, 18 as EntryId, { entries: [entry(15), entry(18)], before: 12 as EntryId });
    const once = withEarlier(window, earlier);
    expect(ids(once)).toEqual([15, 18, 20, 21]);
    expect(once.before).toBe(12);

    earlier = addEarlier(once, earlier, 12 as EntryId, { entries: [entry(11), entry(12)] });
    const start = withEarlier(window, earlier);
    expect(ids(start)).toEqual([11, 12, 15, 18, 20, 21]);
    expect("before" in start).toBe(false);
  });

  it("drops a page that answered a before the shown view no longer has", () => {
    const window = view([20, 21], 18);
    const earlier = addEarlier(window, undefined, 18 as EntryId, { entries: [entry(18)], before: 12 as EntryId });
    // The page asked for 18, but the view now ends at 12: prepending would duplicate or skip entries.
    expect(addEarlier(withEarlier(window, earlier), earlier, 18 as EntryId, { entries: [entry(18)] })).toBe(earlier);
  });

  it("leaves a view with nothing loaded as it is", () => {
    const window = view([20, 21], 18);
    expect(withEarlier(window, undefined)).toBe(window);
  });
});
