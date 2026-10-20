import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ChatChainOfThought,
  ChatTraceRow,
  formatElapsed,
} from "@/shared/ui/chat/chat-chain-of-thought";
import type { ChatToolItem } from "@/shared/ui/chat/chat-tool";
import type { CotPhase, CotStep } from "@pinomad/client/cot-view.ts";

type TraceStep = Exclude<CotStep, { kind: "interim" }>;

function tool(overrides: Partial<ChatToolItem> = {}): ChatToolItem {
  return { state: "output-available", ...overrides };
}

function toolsStep(id: string, tools: ChatToolItem[], live = false): Extract<CotStep, { kind: "tools" }> {
  return { kind: "tools", id, tools, live };
}

function thought(id: string, text = "", live = false): TraceStep {
  return { kind: "thinking", id, text, live };
}

describe("formatElapsed", () => {
  it("claims no number when the wait was never measured", () => {
    expect(formatElapsed(undefined)).toBeUndefined();
    expect(formatElapsed(Number.NaN)).toBeUndefined();
  });

  it("rounds a measured wait to at least one second", () => {
    expect(formatElapsed(400)).toBe("1s");
    expect(formatElapsed(16_400)).toBe("16s");
  });

  it("splits into minutes once the wait reaches a minute", () => {
    expect(formatElapsed(59_400)).toBe("59s");
    expect(formatElapsed(59_600)).toBe("1m 0s");
    expect(formatElapsed(75_400)).toBe("1m 15s");
    expect(formatElapsed(3_599_400)).toBe("59m 59s");
  });

  it("splits into hours once the wait reaches an hour", () => {
    expect(formatElapsed(3_599_600)).toBe("1h 0m 0s");
    expect(formatElapsed(3_665_000)).toBe("1h 1m 5s");
    expect(formatElapsed(7_322_400)).toBe("2h 2m 2s");
  });
});

describe("ChatChainOfThought phase", () => {
  function renderPhase(phase: CotPhase, props: Record<string, unknown> = {}) {
    return render(
      <ChatChainOfThought phase={phase} {...props}>
        <ChatTraceRow steps={[thought("t1", "Reasoning body text")]} counted={[]} />
      </ChatChainOfThought>,
    );
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders nothing before the run's first model call", () => {
    const { container } = renderPhase("hidden");

    expect(container).toBeEmptyDOMElement();
  });

  it("ends with a status line while thinking", () => {
    const { container } = renderPhase("thinking", { elapsedMs: 26_400 });

    expect(container.querySelector('[data-slot="chat-status-line"]')).toBeInTheDocument();
    expect(screen.getByText("26.4s")).toBeInTheDocument();
  });

  it("takes the status line down once the answer starts", () => {
    const { container } = renderPhase("answering", { elapsedMs: 26_400 });

    expect(container.querySelector('[data-slot="chat-status-line"]')).not.toBeInTheDocument();
  });

  // ADR-0026 §1: no "Worked for" header any more — the trace rows are the
  // whole fold, and the duration rides on the last of them.
  it("adds no header of its own when the run settles", () => {
    renderPhase("settled", { elapsedMs: 16_400 });

    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.queryByText(/Worked/)).not.toBeInTheDocument();
  });

  it("ticks the live clock from the run's anchor", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-04T04:00:00.000Z"));

    renderPhase("thinking", { startedAtMs: Date.now() - 2000 });

    expect(screen.getByText("2.0s")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1200);
    });

    expect(screen.getByText("3.2s")).toBeInTheDocument();
  });

  // Replay fixtures and retry gaps carry no anchor; a clock started at mount
  // would pass the time since the page opened off as the run's wait, and a
  // frozen "0.0s" would claim the run just started (ADR-0030 §6).
  it("shows no clock at all when the anchor is missing", () => {
    vi.useFakeTimers();

    const { container } = renderPhase("thinking");

    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(container.querySelector('[data-slot="chat-status-line"]')).toBeInTheDocument();
    expect(container.querySelector(".chat-status-line__clock")).not.toBeInTheDocument();
  });
});

describe("ChatTraceRow", () => {
  it("sums the whole segment into one verb line with its diff stat and failures", () => {
    const steps = [
      toolsStep("a", [tool({ toolName: "bash" }), tool({ toolName: "bash", state: "output-error" })]),
      thought("b"),
      toolsStep("c", [tool({ toolName: "edit", diffStat: { additions: 3, deletions: 1 } })]),
    ];
    render(<ChatTraceRow steps={steps} counted={steps.flatMap((step) => (step.kind === "tools" ? step.tools : []))} />);

    expect(screen.getByRole("button", { name: "Ran 2 commands, edited 1 file +3 -1 1 failed" })).toBeInTheDocument();
  });

  it("reads Thought when the segment only thought", () => {
    render(<ChatTraceRow steps={[thought("a"), thought("b")]} counted={[]} />);

    expect(screen.getByRole("button", { name: "Thought" })).toBeInTheDocument();
  });

  // The row counts what it is handed; the segment decides what that is
  // (todo_write is left out). Expanded, every step is still listed.
  it("lists every step in order when opened, uncounted calls included", async () => {
    const user = userEvent.setup();
    const todo = tool({ toolName: "todo_write" });
    const bash = tool({ toolName: "bash", argsText: JSON.stringify({ command: "bun test" }) });
    const { container } = render(
      <ChatTraceRow steps={[toolsStep("a", [todo]), thought("b", "Plan the fix"), toolsStep("c", [bash])]} counted={[bash]} />,
    );

    const row = screen.getByRole("button", { name: "Ran bun test" });
    expect(row).toHaveAttribute("aria-expanded", "false");
    await user.click(row);

    expect(row).toHaveAttribute("aria-expanded", "true");
    const listed = [...container.querySelectorAll('[data-slot="chat-tool-step"], [data-slot="chat-thought-step"]')];
    expect(listed.map((node) => node.getAttribute("data-slot"))).toEqual(["chat-tool-step", "chat-thought-step", "chat-tool-step"]);
    expect(screen.getByRole("button", { name: /Used todo_write/ })).toBeInTheDocument();
  });

  it("carries the run's duration at its end", () => {
    render(<ChatTraceRow steps={[toolsStep("a", [tool({ toolName: "bash" })])]} counted={[tool({ toolName: "bash" })]} tail="6m 0s" />);

    expect(screen.getByRole("button", { name: "Ran 1 command · 6m 0s" })).toBeInTheDocument();
  });

  // A call still executing has not "Ran" yet: the summary keeps to what
  // finished and names the work in flight after it.
  it("names what is still running after what already finished", () => {
    const done = tool({ toolName: "read", argsText: JSON.stringify({ path: "src/parser.ts" }) });
    const running = tool({ toolName: "bash", toolCallId: "c2", state: "input-available" });
    const { rerender } = render(
      <ChatTraceRow steps={[toolsStep("a", [done]), { ...toolsStep("b", [running], true), activeToolCallId: "c2" }]} counted={[done, running]} live />,
    );
    expect(screen.getByRole("button", { name: "Read src/parser.ts · Running bash…" })).toBeInTheDocument();

    rerender(<ChatTraceRow steps={[thought("a", "", true)]} counted={[]} live />);
    expect(screen.getByRole("button", { name: "Thinking…" })).toBeInTheDocument();
  });

  it("stays shut while the run is live, and the user can fold it again mid-run", async () => {
    const user = userEvent.setup();
    const first = [toolsStep("a", [tool({ toolName: "bash" })])];
    const { rerender } = render(<ChatTraceRow steps={first} counted={first.flatMap((step) => (step.kind === "tools" ? step.tools : []))} live />);

    const row = screen.getByRole("button", { name: /Ran 1 command/ });
    expect(row).toHaveAttribute("aria-expanded", "false");

    await user.click(row);
    expect(row).toHaveAttribute("aria-expanded", "true");
    await user.click(row);
    expect(row).toHaveAttribute("aria-expanded", "false");

    // More steps stream in; the row keeps the user's choice.
    const more = [...first, toolsStep("b", [tool({ toolName: "bash", state: "input-available" })], true)];
    rerender(<ChatTraceRow steps={more} counted={more.flatMap((step) => (step.kind === "tools" ? step.tools : []))} live />);
    expect(screen.getByRole("button", { name: /Ran 1 command · Running bash…/ })).toHaveAttribute("aria-expanded", "false");

    // Settling does not open it.
    const settled = [first[0]!, toolsStep("b", [tool({ toolName: "bash" })])];
    rerender(<ChatTraceRow steps={settled} counted={settled.flatMap((step) => (step.kind === "tools" ? step.tools : []))} tail="12s" />);
    expect(screen.getByRole("button", { name: /Ran 2 commands · 12s/ })).toHaveAttribute("aria-expanded", "false");
  });
});

// Two layout premises the ADR-0030 prototype tripped over: the block contains
// its own inline size so a nowrap step row cannot burst the chat column, and
// the message body is stretched because nothing inside it asks for width any
// more. jsdom applies no stylesheet, so the rules are asserted at their source
// — both were checked in a browser against the real Astryx message layout.
describe("Chain of Thought layout rules", () => {
  const css = readFileSync(
    join(process.cwd(), "apps/web/src/shared/ui/chat/chat.css"),
    "utf8",
  );

  it("contains the block's inline size", () => {
    expect(css).toMatch(/\.chain-of-thought \{[^}]*contain: inline-size;/);
  });

  it("stretches an assistant message body that holds one", () => {
    expect(css).toMatch(
      /\.chat-message__body:has\(> \.chain-of-thought\) \{[^}]*align-self: stretch;/,
    );
  });
});
