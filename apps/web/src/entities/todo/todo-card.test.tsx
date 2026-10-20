import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatEntry } from "@pinomad/client/cot-view.ts";
import type { TodoItem } from "@pinomad/protocol/presentation.ts";
import { lastTodoWriteMs, TodoCard } from "./todo-card.tsx";

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
    render(<TodoCard todo={{ items: plan }} writtenThisRun updatedAtMs={Date.now()} />);

    const header = screen.getByRole("button", { name: /Todo 2\/4/ });
    expect(header).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Read the failing test").closest("s, del")).not.toBeNull();
    expect(screen.getByText("Patch the parser").closest("s, del")).toBeNull();
  });

  // The model may write the plan once and never again: unfinished items keep
  // the card under the next run, and the age of that write is exactly what
  // says the plan may be stale.
  it("stays under a run that did not write it while items are unfinished, dated by the last write", () => {
    render(<TodoCard todo={{ items: plan }} writtenThisRun={false} updatedAtMs={Date.now() - 6 * 60_000} />);

    expect(screen.getByRole("button", { name: /Todo 2\/4/ })).toBeInTheDocument();
    expect(screen.getByText("Updated 6m ago")).toBeInTheDocument();
  });

  it("does not appear when the run left it alone and nothing is unfinished", () => {
    const { container } = render(<TodoCard todo={{ items: done }} writtenThisRun={false} updatedAtMs={Date.now()} />);

    expect(container).toBeEmptyDOMElement();
  });

  it("does not appear without a todo document", () => {
    const { container } = render(<TodoCard todo={undefined} writtenThisRun updatedAtMs={Date.now()} />);

    expect(container).toBeEmptyDOMElement();
  });

  it("makes no claim about its age when no run ever stamped a write", () => {
    render(<TodoCard todo={{ items: plan }} writtenThisRun={false} />);

    expect(screen.queryByText(/Updated/)).not.toBeInTheDocument();
  });

  it("collapses to the count and the current item from its header", async () => {
    const user = userEvent.setup();
    render(<TodoCard todo={{ items: plan }} writtenThisRun />);

    await user.click(screen.getByRole("button", { name: /Todo 2\/4/ }));

    const header = screen.getByRole("button", { name: /Todo 2\/4 · Patch the parser/ });
    expect(header).toHaveAttribute("aria-expanded", "false");
  });

  it("folds into one finished line once every item is done", () => {
    render(<TodoCard todo={{ items: done }} writtenThisRun />);

    const header = screen.getByRole("button", { name: /Todo 4\/4/ });
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByLabelText("All done")).toBeInTheDocument();
  });

  it("keeps counting how long ago the list changed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-20T10:00:00.000Z"));

    render(<TodoCard todo={{ items: plan }} writtenThisRun updatedAtMs={Date.now() - 6 * 60_000} />);
    expect(screen.getByText("Updated 6m ago")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(60 * 60_000);
    });
    expect(screen.getByText("Updated 1h ago")).toBeInTheDocument();
  });
});

describe("lastTodoWriteMs", () => {
  function run(id: string, todoWrittenAtMs?: number): ChatEntry {
    return {
      kind: "run",
      id,
      interrupted: false,
      cot: { phase: "settled", steps: [], ...(todoWrittenAtMs === undefined ? {} : { todoWrittenAtMs }) },
    };
  }

  // Runs do not come in write order once a fork or a retry is in the list,
  // and the newest runs often never touch the plan.
  it("takes the latest write across every run, not the newest run's", () => {
    expect(lastTodoWriteMs([run("a", 2_000), run("b", 5_000), run("c", 3_000), run("d")])).toBe(5_000);
  });

  it("is absent when no run wrote the list", () => {
    expect(lastTodoWriteMs([run("a"), { kind: "user", id: "u", text: "hi", images: [] }])).toBeUndefined();
  });
});
