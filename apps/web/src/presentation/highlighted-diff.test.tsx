// Which files Pierre highlights, and which stay on the caller's plain lines.
import { act, render, screen } from "@testing-library/react";
import { Suspense } from "react";
import { describe, expect, it, vi } from "vitest";
import HighlightedFile from "./highlighted-diff.tsx";

// jsdom has no shadow-DOM highlighter; name the file Pierre would render.
vi.mock("@pierre/diffs", async (original) => ({
  ...(await original<typeof import("@pierre/diffs")>()),
  preloadHighlighter: () => Promise.resolve(),
}));
vi.mock("@pierre/diffs/react", () => ({
  FileDiff: ({ fileDiff }: { fileDiff: { name: string } }) => <span>highlighted {fileDiff.name}</span>,
}));

const whole = ["diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", "@@ -1,2 +1,2 @@", " x", "-const a = 1;", "+const a = 2;", ""];
// The host cuts a long Changes patch at a line, which can fall inside a hunk.
const cut = ["diff --git a/b.ts b/b.ts", "--- a/b.ts", "+++ b/b.ts", "@@ -1,5 +1,5 @@", " x", "-const b = 1;", ""];

// Async act, so the render that waits on the (mocked) highlighter resumes.
async function show(patch: string, path: string) {
  await act(async () => {
    render(
      <Suspense>
        <HighlightedFile patch={patch} path={path} fallback={<span>plain {path}</span>} />
      </Suspense>,
    );
  });
}

describe("HighlightedFile", () => {
  it("highlights the whole files of a patch cut mid-hunk and leaves the cut one plain", async () => {
    const patch = [...whole, ...cut].join("\n");
    await show(patch, "a.ts");
    await show(patch, "b.ts");
    expect(screen.getByText("highlighted a.ts")).toBeInTheDocument();
    expect(screen.getByText("plain b.ts")).toBeInTheDocument();
  });

  it("finds a file by its path when the patch has no diff --git line", async () => {
    await show(whole.slice(1).join("\n"), "a.ts");
    expect(screen.getByText(/^highlighted .*a\.ts$/)).toBeInTheDocument();
  });
});
