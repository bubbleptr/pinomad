// Copyright (c) Meta Platforms, Inc. and affiliates.
// Ported from @astryxdesign/core 0.3.0 (src/CodeBlock/CodeBlock.test.tsx), MIT.

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CodeBlock } from "./code-block";

// A code sample long enough to exceed the default collapsible threshold (10).
const LONG_CODE = Array.from({ length: 15 }, (_, i) => `const line${i} = ${i};`).join("\n");

function collapsibleHeader() {
  return screen.getAllByRole("button").find((el) => el.hasAttribute("aria-expanded"))!;
}

describe("CodeBlock", () => {
  beforeEach(() => {
    // jsdom does not implement the async Clipboard API.
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it("renders the code", () => {
    render(<CodeBlock code="const x = 1;" language="javascript" />);
    expect(screen.getByText(/const/)).toBeInTheDocument();
  });

  it("colors tokens with span classes where the Highlight API is missing", () => {
    const { container } = render(<CodeBlock code="const x = 1;" language="javascript" />);
    expect(container.querySelector(".token-keyword")).toHaveTextContent("const");
    expect(container.querySelector(".token-number")).toHaveTextContent("1");
  });

  it("renders unknown languages as plain text", () => {
    const { container } = render(<CodeBlock code="plain body" language="not-a-language" />);
    expect(container.querySelector('[class^="token-"]')).toBeNull();
    expect(screen.getByText("plain body")).toBeInTheDocument();
  });

  it("makes the scroll container keyboard-focusable", () => {
    render(<CodeBlock code="const x = 1;" language="javascript" />);
    const region = screen.getByRole("group");
    expect(region).toHaveAttribute("tabindex", "0");
    expect(region).toHaveAttribute("aria-label", "javascript");
  });

  it('labels the scroll region "Code" when no language label is shown', () => {
    render(<CodeBlock code="hello" hasLanguageLabel={false} />);
    expect(screen.getByRole("group")).toHaveAttribute("aria-label", "Code");
  });

  it("copies code when the copy button is clicked", () => {
    render(<CodeBlock code="const x = 1;" language="javascript" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("const x = 1;");
  });

  it("omits the copy button when hasCopyButton is false", () => {
    render(<CodeBlock code="x" hasCopyButton={false} />);
    expect(screen.queryByRole("button", { name: "Copy code" })).toBeNull();
  });

  it('announces "Copied" to a polite live region after copying', async () => {
    render(<CodeBlock code="const x = 1;" language="javascript" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent("Copied");
    });
  });

  it("keeps the copied indicator a full 2s after a rapid re-copy", async () => {
    vi.useFakeTimers();
    try {
      render(<CodeBlock code="const x = 1;" language="javascript" />);
      fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
      // Flush the async clipboard write.
      await act(async () => {});
      expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();

      // 1.5s later the user copies again.
      act(() => {
        vi.advanceTimersByTime(1500);
      });
      fireEvent.click(screen.getByRole("button", { name: "Copied" }));
      await act(async () => {});

      // 600ms after the second copy (2.1s after the first): the first
      // click's timer must not have reverted the indicator early.
      act(() => {
        vi.advanceTimersByTime(600);
      });
      expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();

      // It resets 2s after the most recent copy.
      act(() => {
        vi.advanceTimersByTime(1400);
      });
      expect(screen.getByRole("button", { name: "Copy code" })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("is not collapsible below the threshold", () => {
    render(<CodeBlock code="a\nb" language="javascript" isCollapsible />);
    expect(screen.getAllByRole("button").some((el) => el.hasAttribute("aria-expanded"))).toBe(false);
  });

  it("does NOT collapse the block when the copy button is clicked", () => {
    render(<CodeBlock code={LONG_CODE} language="javascript" title="example" isCollapsible />);
    const header = collapsibleHeader();
    expect(header).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));

    expect(header).toHaveAttribute("aria-expanded", "true");
    expect(navigator.clipboard.writeText).toHaveBeenCalled();
  });

  it('does not nest the copy button inside the collapsible header role="button"', () => {
    render(<CodeBlock code={LONG_CODE} language="javascript" title="example" isCollapsible />);
    expect(collapsibleHeader().contains(screen.getByRole("button", { name: "Copy code" }))).toBe(false);
  });

  it("toggles collapse from the header by click and keyboard", () => {
    render(<CodeBlock code={LONG_CODE} language="javascript" title="example" isCollapsible />);
    const header = collapsibleHeader();
    fireEvent.click(header);
    expect(header).toHaveAttribute("aria-expanded", "false");
    fireEvent.keyDown(header, { key: "Enter" });
    expect(header).toHaveAttribute("aria-expanded", "true");
  });

  it("links the collapsible header to its code region via aria-controls", () => {
    render(<CodeBlock code={LONG_CODE} language="javascript" title="example" isCollapsible />);
    const region = document.getElementById(collapsibleHeader().getAttribute("aria-controls")!);
    expect(region).not.toBeNull();
    expect(region).toContainElement(screen.getByRole("group"));
  });

  it("makes the collapsed region inert and restores it on expand", () => {
    render(<CodeBlock code={LONG_CODE} language="javascript" title="example" isCollapsible />);
    const header = collapsibleHeader();
    const region = document.getElementById(header.getAttribute("aria-controls")!)!;
    expect(region).not.toHaveAttribute("inert");

    fireEvent.click(header);
    // The region stays mounted (a 0fr grid row), so aria-controls resolves.
    expect(document.getElementById(header.getAttribute("aria-controls")!)).toBe(region);
    expect(region).toHaveAttribute("inert");
    expect(screen.getByRole("group").closest("[inert]")).toBe(region);

    fireEvent.click(header);
    expect(region).not.toHaveAttribute("inert");
    expect(screen.getByRole("group").closest("[inert]")).toBeNull();
  });
});
