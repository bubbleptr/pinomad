import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
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

function renderRun(entry: RunEntry, todo?: TodoState) {
  return render(
    <ChatEntryView entry={entry} connected openInPanel={() => {}} onFork={() => {}} canFork={false} todo={todo} />,
  );
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

  it("keeps the rows shut while the run is live and ends with the status line", async () => {
    const user = userEvent.setup();
    const live: CotStep[] = [
      narrated[1]!,
      { kind: "interim", id: "live-text-0", text: "Running the suite now." },
      { kind: "tools", id: "live-tools-1", tools: [bash("c3", "bun test", "input-available")], live: true, activeToolCallId: "c3" },
    ];
    const { container, rerender } = renderRun(run({ phase: "acting", anchorMs: Date.now(), steps: live }));

    const rows = [...container.querySelectorAll('[data-slot="chat-trace-trigger"]')];
    expect(rows.map((row) => [row.textContent, row.getAttribute("aria-expanded")])).toEqual([
      ["Ran 2 commands", "false"],
      ["Running bash…", "false"],
    ]);
    expect(container.querySelector(".chain-of-thought")?.lastElementChild).toHaveAttribute("data-slot", "chat-status-line");

    // Opened and shut again mid-run; settling must not unfold it.
    await user.click(rows[1]!);
    await user.click(rows[1]!);
    const settled = run({ elapsedMs: 9_000, steps: [narrated[1]!, live[1]!, { ...narrated[3]!, id: "c-tools-1" }] });
    rerender(<ChatEntryView entry={settled} connected openInPanel={() => {}} onFork={() => {}} canFork={false} />);
    expect(screen.getByRole("button", { name: "Ran bun test · 9s" })).toHaveAttribute("aria-expanded", "false");
    expect(container.querySelector('[data-slot="chat-status-line"]')).toBeNull();
  });

  it("puts the todo card after everything else in the run", () => {
    const { container } = renderRun(
      run({ elapsedMs: 9_000, todoWrittenAtMs: Date.now(), steps: narrated, answer: { text: "All fixed.", streaming: false } }),
      plan,
    );

    const body = container.querySelector(".chat-message__body")!;
    expect(body.lastElementChild).toHaveAttribute("data-slot", "todo-card");
    expect(screen.getByText("Updated just now")).toBeInTheDocument();
  });
});
