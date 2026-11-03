// A highlighter chunk that fails to load (say, a network blip on first use)
// must leave the plain lines up, not take the page down.
import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DiffView } from "./diff.tsx";

vi.mock("./highlighted-diff.tsx", () => {
  throw new Error("Failed to fetch dynamically imported module");
});

describe("DiffView without its highlighter", () => {
  it("keeps the plain lines when the highlighter fails to load", async () => {
    const patch = ["--- a/a.ts", "+++ b/a.ts", "@@ -1 +1 @@", "-const a = 1;", "+const a = 2;", ""].join("\n");
    await act(async () => {
      render(<DiffView patch={patch} />);
    });
    await act(async () => {});
    expect(screen.getByText("+const a = 2;")).toBeInTheDocument();
  });
});
