// The Changes surface folds a long patch's files so opening it stays cheap;
// tool-result diffs keep rendering every line.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { DiffView } from "./diff.tsx";

// jsdom has no shadow-DOM highlighter; the plain lines stand in for it.
vi.mock("./highlighted-diff.tsx", () => ({ default: ({ fallback }: { fallback: ReactNode }) => fallback }));

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

  it("keeps the reader's choice when a refresh carries the patch past the fold threshold", async () => {
    const user = userEvent.setup();
    const short = filePatch("a.ts", 3);
    const { rerender } = render(<DiffView patch={short} collapsible />);
    await user.click(screen.getByRole("button", { name: /a\.ts/ }));
    expect(screen.queryByText("+a.ts line 0")).toBeNull();

    // New edits push the patch over the threshold: untouched files fold, the reader's fold stands.
    rerender(<DiffView patch={[filePatch("a.ts", 3), filePatch("b.ts", 500)].join("\n")} collapsible />);
    expect(screen.queryByText("+a.ts line 0")).toBeNull();
    expect(screen.queryByText("+b.ts line 0")).toBeNull();

    // And back under it: a.ts stays folded, untouched files open again.
    rerender(<DiffView patch={[filePatch("a.ts", 3), filePatch("c.ts", 3)].join("\n")} collapsible />);
    expect(screen.queryByText("+a.ts line 0")).toBeNull();
    expect(screen.getByText("+c.ts line 0")).toBeInTheDocument();
  });
});
