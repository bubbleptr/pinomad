import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatEntry, CotStep, CotView } from "@pinomad/client/cot-view.ts";
import type { ToolItem } from "@pinomad/client/tool-item.ts";
import type { TodoState } from "@pinomad/protocol/presentation.ts";
import { ChatEntryView } from "./chat-entries.tsx";

type RunEntry = Extract<ChatEntry, { kind: "run" }>;

function bash(id: string, command: string, state: ToolItem["state"] = "output-available"): ToolItem {
  return { toolName: "bash", toolCallId: id, argsText: JSON.stringify({ command }), state };
}

function run(cot: Partial<CotView> & { steps: CotStep[] }, overrides: Partial<RunEntry> = {}): RunEntry {
  return { kind: "run", id: "run-1", interrupted: false, cot: { phase: "settled", ...cot }, ...overrides };
}

function renderRun(entry: RunEntry, todo?: { state: TodoState; updatedAtMs?: number }) {
  return render(
    <ChatEntryView entry={entry} connected openInPanel={() => {}} onFork={() => {}} canFork={false} todo={todo} />,
  );
}

function userEntry(timestamp?: number): Extract<ChatEntry, { kind: "user" }> {
  return {
    kind: "user",
    id: "user-1",
    text: "hi",
    images: [],
    skills: [],
    attachments: [],
    ...(timestamp === undefined ? {} : { timestamp }),
  };
}

function renderUser(entry: Extract<ChatEntry, { kind: "user" }>) {
  return render(<ChatEntryView entry={entry} connected openInPanel={() => {}} onFork={() => {}} canFork={false} />);
}

const narrated: CotStep[] = [
  { kind: "thinking", id: "a-thinking-0", text: "", live: false },
  { kind: "tools", id: "a-tools-1", tools: [bash("c1", "ls"), bash("c2", "cat x")], live: false },
  { kind: "interim", id: "b-text-0", text: "Found the parser bug." },
  { kind: "tools", id: "b-tools-1", tools: [bash("c3", "bun test")], live: false },
];

const plan: TodoState = {
  items: [
    { text: "Find the bug", status: "completed" },
    { text: "Fix it", status: "in_progress" },
  ],
};

describe("local submission states", () => {
  const local = (status: "sending" | "unknown" | "failed", error?: string): Extract<ChatEntry, { kind: "user" }> => ({
    ...userEntry(),
    id: "local:r1",
    status,
    local: { requestId: "r1", ...(error === undefined ? {} : { error }) },
  });

  it("labels an unconfirmed send and retries with its requestId", async () => {
    const onRetry = vi.fn();
    render(
      <ChatEntryView
        entry={local("unknown")}
        connected
        openInPanel={() => {}}
        onFork={() => {}}
        onRetrySubmission={onRetry}
        onEditSubmission={() => {}}
      />,
    );
    expect(screen.getByText("Not confirmed")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledWith("r1");
  });

  it("shows a failed send's error with Retry and Edit", async () => {
    const onRetry = vi.fn();
    const onEdit = vi.fn();
    render(
      <ChatEntryView
        entry={local("failed", "The host refused this message")}
        connected
        openInPanel={() => {}}
        onFork={() => {}}
        onRetrySubmission={onRetry}
        onEditSubmission={onEdit}
      />,
    );
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByText("The host refused this message")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(onEdit).toHaveBeenCalledWith("r1");
  });

  it("renders Delivered only for a committed newest bubble", () => {
    renderUser({ ...userEntry(Date.now()), status: "delivered" });
    expect(screen.getByText("Delivered")).toBeInTheDocument();
  });
});

describe("message times", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 28, 15, 0));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows only the time on a user message from today", () => {
    const sentAt = new Date(2026, 9, 28, 14, 31).getTime();
    const { container } = renderUser(userEntry(sentAt));
    const time = container.querySelector('[data-slot="chat-message-time"]')!;
    const month = new Intl.DateTimeFormat(undefined, { month: "short" }).format(sentAt);

    expect(time.textContent).toMatch(/\d{1,2}:\d{2}/);
    expect(time.textContent).not.toContain(month);
    expect(time.textContent).not.toContain("2026");
    expect(time).toHaveAttribute("datetime", new Date(sentAt).toISOString());
    expect(time).toHaveAttribute("title", expect.stringContaining("2026"));
  });

  it("adds the date to a user message from another day", () => {
    const sentAt = new Date(2026, 9, 27, 14, 31).getTime();
    const { container } = renderUser(userEntry(sentAt));
    const time = container.querySelector('[data-slot="chat-message-time"]')!;
    const month = new Intl.DateTimeFormat(undefined, { month: "short" }).format(sentAt);

    expect(time.textContent).toContain(month);
    expect(time.textContent).not.toContain("2026");
    expect(time).toHaveAttribute("title", expect.stringContaining("2026"));
  });

  it("puts a user's Copy action and time in one metadata row", () => {
    const { container } = renderUser(userEntry(new Date(2026, 9, 28, 14, 31).getTime()));
    fireEvent.mouseOver(container.querySelector('[data-slot="chat-message-bubble"]')!);
    const actions = container.querySelector('[data-slot="chat-message-actions"]')!;
    const time = container.querySelector('[data-slot="chat-message-time"]')!;
    const metadata = container.querySelector(".chat-message__metadata")!;

    expect(metadata.contains(actions)).toBe(true);
    expect(metadata.contains(time)).toBe(true);
  });

  it("puts an assistant's time first in its actions row", () => {
    const endedAt = new Date(2026, 9, 28, 14, 31).getTime();
    const { container } = renderRun(
      run({ steps: [], answer: { text: "Done.", streaming: false } }, { endedAt }),
    );
    const time = container.querySelector('[data-slot="chat-message-time"]')!;
    const copy = screen.getByRole("button", { name: "Copy" });

    expect(time).toHaveTextContent(/\d{1,2}:\d{2}/);
    expect(time.compareDocumentPosition(copy) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("a run in the transcript", () => {
  it("folds a run the model never narrated into a single line with its duration", () => {
    const { container } = renderRun(
      run({ elapsedMs: 360_000, steps: [narrated[0]!, narrated[1]!, narrated[3]!], answer: { text: "Done.", streaming: false } }),
    );

    expect(container.querySelectorAll('[data-slot="chat-trace"]')).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Ran 3 commands · 6m 0s" })).toBeInTheDocument();
    expect(screen.queryByText(/Worked/)).not.toBeInTheDocument();
  });

  // Interim Output is said to the user, so it is prose like the answer, and
  // only the last trace row carries the run's duration.
  it("cuts the trace at interim output and keeps that output in the prose", () => {
    const { container } = renderRun(run({ elapsedMs: 16_400, steps: narrated, answer: { text: "Done.", streaming: false } }));

    const rows = [...container.querySelectorAll('[data-slot="chat-trace-trigger"]')].map((row) => row.textContent);
    expect(rows).toEqual(["Ran 2 commands", "Ran bun test · 16s"]);
    const interim = screen.getByText("Found the parser bug.");
    expect(interim.closest('[data-slot="chat-trace"]')).toBeNull();
    expect(interim.closest(".chat-message__content")).not.toBeNull();
  });

  it("says a failed run failed at the end of its last line", () => {
    renderRun(run({ elapsedMs: 1_400, outcome: "failed", steps: [narrated[1]!] }, { failure: "boom" }));

    expect(screen.getByRole("button", { name: "Ran 2 commands · Failed after 1s" })).toBeInTheDocument();
    expect(screen.getByText("Run failed")).toBeInTheDocument();
  });

  // ADR-0026: no status line of its own — the last row names the work in
  // flight and carries the run's clock, the same place the settled duration
  // goes.
  it("keeps the rows shut while the run is live and puts the clock on the last one", async () => {
    const user = userEvent.setup();
    const live: CotStep[] = [
      narrated[1]!,
      { kind: "interim", id: "live-text-0", text: "Running the suite now." },
      { kind: "tools", id: "live-tools-1", tools: [bash("c3", "bun test", "input-available")], live: true, activeToolCallId: "c3" },
    ];
    const { container, rerender } = renderRun(run({ phase: "acting", anchorMs: Date.now() - 5_000, steps: live }));

    const rows = [...container.querySelectorAll('[data-slot="chat-trace-trigger"]')];
    expect(rows.map((row) => row.getAttribute("aria-expanded"))).toEqual(["false", "false"]);
    expect(rows[0]).toHaveTextContent(/^Ran 2 commands$/);
    expect(rows[1]).toHaveTextContent(/^Running bash… · 5\.\ds$/);
    expect(container.querySelector('[role="status"]')).toBeNull();

    // Opened and shut again mid-run; settling must not unfold it.
    await user.click(rows[1]!);
    await user.click(rows[1]!);
    const settled = run({ elapsedMs: 9_000, steps: [narrated[1]!, live[1]!, { ...narrated[3]!, id: "c-tools-1" }] });
    rerender(<ChatEntryView entry={settled} connected openInPanel={() => {}} onFork={() => {}} canFork={false} />);
    expect(screen.getByRole("button", { name: "Ran bun test · 9s" })).toHaveAttribute("aria-expanded", "false");
  });

  it("starts as one thinking line with its clock before any step lands", () => {
    const { container } = renderRun(run({ phase: "thinking", anchorMs: Date.now() - 1_000, steps: [] }));

    const rows = container.querySelectorAll('[data-slot="chat-trace"]');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent(/^Thinking… · 1\.\ds$/);
  });

  // Prose is never the live end of a run: a bare row follows it and takes
  // the clock, so the rows above stay settled and one clock shows.
  it("ends a live run that last spoke with its own line, not a second clock", () => {
    const { container } = renderRun(
      run({ phase: "thinking", anchorMs: Date.now() - 1_000, steps: [narrated[1]!, { kind: "interim", id: "a-text-2", text: "Checking." }] }),
    );

    const rows = [...container.querySelectorAll('[data-slot="chat-trace"] > :first-child')];
    expect(rows.map((row) => row.textContent?.replace(/\d+\.\ds/, "Ns"))).toEqual(["Ran 2 commands", "Thinking… · Ns"]);
    expect(container.querySelectorAll('[data-slot="chat-trace-clock"]')).toHaveLength(1);
  });

  it("reads a failed todo_write like any other failure", () => {
    const failed: ToolItem = { toolName: "todo_write", toolCallId: "t1", state: "output-error" };
    renderRun(run({ elapsedMs: 2_000, steps: [{ kind: "tools", id: "a-tools-0", tools: [failed], live: false }] }));

    expect(screen.getByRole("button", { name: "Used todo_write 1 failed · 2s" })).toBeInTheDocument();
  });

  it("puts the todo card after everything else in the run", () => {
    const { container } = renderRun(
      run({ elapsedMs: 9_000, todoWrittenAtMs: Date.now(), steps: narrated, answer: { text: "All fixed.", streaming: false } }),
      { state: plan, updatedAtMs: Date.now() },
    );

    const body = container.querySelector(".chat-message__body")!;
    expect(body.lastElementChild).toHaveAttribute("data-slot", "todo-card");
    expect(screen.getByText("Updated just now")).toBeInTheDocument();
  });

  // A run that left the list alone still shows when it last changed: that
  // is when it is most likely to be out of date.
  it("dates the card from an earlier run's write", () => {
    renderRun(run({ elapsedMs: 9_000, steps: narrated, answer: { text: "Next.", streaming: false } }), {
      state: plan,
      updatedAtMs: Date.now() - 6 * 60_000,
    });

    expect(screen.getByText("Updated 6m ago")).toBeInTheDocument();
  });
});
