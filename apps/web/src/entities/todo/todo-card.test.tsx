import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TodoItem } from "@pinomad/protocol/presentation.ts";
import { TodoCard } from "./todo-card.tsx";

const plan: TodoItem[] = [
  { text: "Read the failing test", status: "completed" },
  { text: "Find the root cause", status: "completed" },
  { text: "Patch the parser", status: "in_progress" },
  { text: "Run the suite", status: "pending" },
];

const done: TodoItem[] = plan.map((item) => ({ ...item, status: "completed" }));

describe("TodoCard", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the list the run just wrote, expanded, with finished items struck", () => {
    render(<TodoCard todo={{ items: plan }} writtenAtMs={Date.now()} />);

    const header = screen.getByRole("button", { name: /Todo 2\/4/ });
    expect(header).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Read the failing test").closest("s, del")).not.toBeNull();
    expect(screen.getByText("Patch the parser").closest("s, del")).toBeNull();
  });

  // The model may write the plan once and never again: unfinished items keep
  // the card under the next run even though that run never touched it.
  it("stays under a run that did not write it while items are unfinished", () => {
    render(<TodoCard todo={{ items: plan }} />);

    expect(screen.getByRole("button", { name: /Todo 2\/4/ })).toBeInTheDocument();
    // No write in this run, so no claim about when the list last changed.
    expect(screen.queryByText(/Updated/)).not.toBeInTheDocument();
  });

  it("does not appear when the run left it alone and nothing is unfinished", () => {
    const { container } = render(<TodoCard todo={{ items: done }} />);

    expect(container).toBeEmptyDOMElement();
  });

  it("does not appear without a todo document", () => {
    const { container } = render(<TodoCard todo={undefined} writtenAtMs={Date.now()} />);

    expect(container).toBeEmptyDOMElement();
  });

  it("collapses to the count and the current item from its header", async () => {
    const user = userEvent.setup();
    render(<TodoCard todo={{ items: plan }} writtenAtMs={Date.now()} />);

    await user.click(screen.getByRole("button", { name: /Todo 2\/4/ }));

    const header = screen.getByRole("button", { name: /Todo 2\/4 · Patch the parser/ });
    expect(header).toHaveAttribute("aria-expanded", "false");
  });

  it("folds into one finished line once every item is done", () => {
    render(<TodoCard todo={{ items: done }} writtenAtMs={Date.now()} />);

    const header = screen.getByRole("button", { name: /Todo 4\/4/ });
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByLabelText("All done")).toBeInTheDocument();
  });

  it("says how long ago the run last wrote it, and keeps counting", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-20T10:00:00.000Z"));

    render(<TodoCard todo={{ items: plan }} writtenAtMs={Date.now() - 6 * 60_000} />);
    expect(screen.getByText("Updated 6m ago")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(60 * 60_000);
    });
    expect(screen.getByText("Updated 1h ago")).toBeInTheDocument();
  });
});
