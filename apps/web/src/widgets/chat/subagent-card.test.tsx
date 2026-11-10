// A background `subagent` call returns as soon as it dispatched (ADR-0046 §1):
// its card must follow the subagent, not the finished call.
import type { ConversationId } from "@earendil-works/pi-durable";
import type { ConversationToolItem } from "@pinomad/client/cot-view.ts";
import type { ConversationSummary } from "@pinomad/protocol/view.ts";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SubagentCards } from "./subagent-card.tsx";

const CHILD = 7 as ConversationId;

function call(
  state: ConversationToolItem["state"],
  args: Record<string, unknown>,
  output?: string,
): { key: string; tool: ConversationToolItem } {
  return {
    key: "step/c1",
    tool: {
      toolName: "subagent",
      toolCallId: "c1",
      argsText: JSON.stringify({ task: "count the lines", checkout: "shared", ...args }),
      state,
      ...(output === undefined ? {} : { output }),
      ...(state === "output-error"
        ? {}
        : { pinomad: { kind: "subagent", conversationId: CHILD, model: "faux/faux-1", startedAt: 1_000, endedAt: 2_000 } }),
    },
  };
}

const summary = (patch: Partial<ConversationSummary>): ConversationSummary => ({
  id: CHILD,
  kind: "subagent",
  lifecycle: "background",
  name: "counter",
  label: "Count the lines",
  ...patch,
});

function renderCard(tool: ReturnType<typeof call>, child?: ConversationSummary, openInPanel = vi.fn()) {
  render(<SubagentCards tools={[tool]} summaryOf={() => child} openInPanel={openInPanel} />);
  return document.querySelector<HTMLElement>('[data-slot="subagent-card"]')!;
}

describe("SubagentCards", () => {
  it("shows a background subagent still working after its call returned", () => {
    const card = renderCard(call("output-available", { background: true }), summary({ status: "running" }));
    expect(card).toHaveAttribute("data-status", "running");
    expect(card).toHaveAttribute("data-background");
    expect(screen.getByText("counter")).toBeInTheDocument();
    // The call's 1s handover is not the work's duration.
    expect(card).toHaveTextContent("Background · Running · faux/faux-1");
    expect(card).not.toHaveTextContent("1s");
  });

  it("shows a background subagent idle once it answered, and opens it", () => {
    const open = vi.fn();
    const card = renderCard(call("output-available", { background: true }), summary({}), open);
    expect(card).toHaveAttribute("data-status", "idle");
    expect(card).toHaveTextContent("Background · Idle");
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    expect(open).toHaveBeenCalledWith(CHILD);
  });

  it("shows a background dispatch that failed as the call's failure", () => {
    const card = renderCard(call("output-error", { background: true, name: "counter" }, "A subagent named \"counter\" already exists"));
    expect(card).toHaveAttribute("data-status", "failed");
    expect(card).not.toHaveAttribute("data-background");
    expect(screen.getByText("counter")).toBeInTheDocument();
    expect(card).toHaveTextContent("already exists");
  });

  it("keeps a foreground call's own status and elapsed time", () => {
    const card = renderCard(call("output-available", {}), summary({ lifecycle: "foreground", status: "running" }));
    expect(card).toHaveAttribute("data-status", "done");
    expect(card).toHaveTextContent("Done · faux/faux-1 · 1s");
  });
  it("names the branch of a subagent with its own worktree", () => {
    const tool = call("output-available", { checkout: "worktree" });
    const card = renderCard(
      { ...tool, tool: { ...tool.tool, pinomad: { kind: "subagent", conversationId: CHILD, model: "faux/faux-1", branch: "pinomad/7-ab12" } } },
      summary({ lifecycle: "foreground" }),
    );
    expect(card).toHaveTextContent("Done · faux/faux-1 · pinomad/7-ab12");
  });
});
