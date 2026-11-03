// The Changes surface folds a long patch's files so opening it stays cheap;
// tool-result diffs keep rendering every line.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { DiffView } from "./diff.tsx";

function filePatch(path: string, lines: number): string {
  const added = Array.from({ length: lines }, (_, index) => `+${path} line ${index}`);
  return [`--- a/${path}`, `+++ b/${path}`, `@@ -0,0 +1,${lines} @@`, ...added].join("\n");
}

describe("DiffView collapsible", () => {
  it("folds a long patch's files until one is opened", async () => {
    const user = userEvent.setup();
    render(<DiffView patch={[filePatch("a.ts", 300), filePatch("b.ts", 300)].join("\n")} collapsible />);
    expect(screen.queryByText("+a.ts line 0")).toBeNull();
    expect(screen.queryByText("+b.ts line 0")).toBeNull();

    await user.click(screen.getByRole("button", { name: /a\.ts/ }));
    expect(screen.getByText("+a.ts line 0")).toBeInTheDocument();
    expect(screen.queryByText("+b.ts line 0")).toBeNull();
  });

  it("shows a short patch's lines at once", () => {
    render(<DiffView patch={filePatch("a.ts", 3)} collapsible />);
    expect(screen.getByText("+a.ts line 0")).toBeInTheDocument();
  });
});
