import { describe, expect, it } from "vitest";
import type { TerminalInfo } from "@pinomad/protocol/terminals.ts";
import { partitionTabs, resolveSelection, selectionAfter } from "./terminal-tabs.ts";

const terminal = (id: string): TerminalInfo => ({ id, name: id, renamed: false, cols: 80, rows: 24 });
const ids = (terminals: readonly TerminalInfo[]) => terminals.map((t) => t.id);
const [a, b, c, d] = ["a", "b", "c", "d"].map(terminal) as [TerminalInfo, TerminalInfo, TerminalInfo, TerminalInfo];

describe("selectionAfter", () => {
  it("keeps the selected tab while it is still there", () => {
    expect(selectionAfter([a, b], [a, b, c], "a")).toBe("a");
  });

  it("moves to the tab that took a closed tab's place, or the new last one", () => {
    expect(selectionAfter([a, b, c], [a, c], "b")).toBe("c");
    expect(selectionAfter([a, b, c], [a, b], "c")).toBe("b");
    expect(selectionAfter([a], [], "a")).toBeUndefined();
  });

  it("selects the first tab when nothing was selected", () => {
    expect(selectionAfter([], [a, b], undefined)).toBe("a");
  });
});

describe("partitionTabs", () => {
  it("keeps creation order and sends what doesn't fit to the menu", () => {
    const { inline, overflow } = partitionTabs([a, b, c, d], "a", 2);
    expect(ids(inline)).toEqual(["a", "b"]);
    expect(ids(overflow)).toEqual(["c", "d"]);
  });

  it("keeps the selected tab outside the menu, in its place among the inline ones", () => {
    const { inline, overflow } = partitionTabs([a, b, c, d], "c", 2);
    expect(ids(inline)).toEqual(["a", "c"]);
    expect(ids(overflow)).toEqual(["b", "d"]);
  });

  it("always shows the selected tab, even when nothing fits", () => {
    expect(ids(partitionTabs([a, b, c], "c", 0).inline)).toEqual(["c"]);
  });
});

describe("resolveSelection", () => {
  it("keeps the last selection while a just-opened terminal's list hasn't arrived, then selects it", () => {
    const waiting = resolveSelection({ selected: "a", pending: "c", seen: [a, b] }, [a, b]);
    expect(waiting.selected).toBe("a");
    const arrived = resolveSelection(waiting.memory, [a, b, c]);
    expect(arrived.selected).toBe("c");
    expect(arrived.memory).toEqual({ selected: "c", seen: [a, b, c] });
  });

  it("follows a closed tab's neighbour from the list it last saw", () => {
    expect(resolveSelection({ selected: "b", seen: [a, b, c] }, [a, c]).selected).toBe("c");
  });
});
