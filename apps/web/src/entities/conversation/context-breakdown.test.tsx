import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ExtensionDocView } from "@pinomad/protocol/view.ts";
import { ContextBreakdownList, matchingBreakdown } from "./context-breakdown.tsx";

const PARTS = { used: 124_000, system: 8_100, skills: 3_200, tools: 12_000, mcp: 0, messages: 100_700 };
const doc = (value: unknown, presentation: ExtensionDocView["presentation"] = "pinomad.context"): ExtensionDocView =>
  ({ kind: "context.breakdown", presentation, value }) as ExtensionDocView;

describe("ContextBreakdownList", () => {
  const rowsOf = () => within(screen.getByRole("list", { name: "Context breakdown" })).getAllByRole("listitem").map((row) => row.textContent);

  it("lists each part that takes space with its tokens, then what is left", () => {
    render(<ContextBreakdownList usage={{ used: 124_000, window: 200_000 }} breakdown={PARTS} />);
    expect(rowsOf()).toEqual(["System8k", "Skills3k", "Tools12k", "Messages101k", "Left76k"]);
  });

  it("still says what is left without a breakdown, and nothing is left past the window", () => {
    const { rerender } = render(<ContextBreakdownList usage={{ used: 124_000, window: 200_000 }} breakdown={undefined} />);
    expect(rowsOf()).toEqual(["Left76k"]);
    rerender(<ContextBreakdownList usage={{ used: 250_000, window: 200_000 }} breakdown={{ ...PARTS, used: 250_000, messages: 226_700 }} />);
    expect(rowsOf()).not.toContainEqual(expect.stringMatching(/^Left/));
  });
});

describe("matchingBreakdown", () => {
  const usage = { used: 124_000, window: 200_000 };

  it("returns the host's breakdown while it belongs to the reply the meter shows", () => {
    expect(matchingBreakdown([doc(PARTS)], usage)).toEqual(PARTS);
  });

  it("drops a breakdown from another reply, a missing meter, and a malformed document", () => {
    expect(matchingBreakdown([doc({ ...PARTS, used: 90_000, messages: 66_700 })], usage)).toBeUndefined();
    expect(matchingBreakdown([doc(PARTS)], undefined)).toBeUndefined();
    expect(matchingBreakdown([doc({ used: 124_000 })], usage)).toBeUndefined();
    expect(matchingBreakdown([{ kind: "context.breakdown", value: PARTS }], usage)).toBeUndefined();
  });
});
