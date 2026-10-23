import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AgentRole } from "@pinomad/protocol/agents.ts";
import type { ModelSummary } from "@pinomad/protocol/view.ts";
import { ModelSelector, type ModelSelectorAgent } from "./model-selector.tsx";

const models: readonly ModelSummary[] = [
  { provider: "anthropic", modelId: "claude-a", name: "Claude A", contextWindow: 200_000, thinkingLevels: ["off", "high"] },
];

const roles: readonly AgentRole[] = [
  { name: "reviewer", description: "Reviews diffs for correctness", prompt: "You review changes." },
  { name: "planner", description: "Turns a request into a plan", prompt: "Plan first." },
];

type AgentInput =
  | Omit<Extract<ModelSelectorAgent, { kind: "pick" }>, "onChange">
  | Extract<ModelSelectorAgent, { kind: "fixed" }>;

function setup(agent: AgentInput) {
  const onAgentChange = vi.fn();
  const view = render(
    <ModelSelector
      models={models}
      selected={{ model: { provider: "anthropic", modelId: "claude-a" }, level: "off" }}
      agent={agent.kind === "pick" ? { ...agent, onChange: onAgentChange } : agent}
      onModelChange={vi.fn()}
      onLevelChange={vi.fn()}
    />,
  );
  return { onAgentChange, rerender: view.rerender };
}

async function open(): Promise<HTMLElement> {
  const user = userEvent.setup();
  await user.click(screen.getByTestId("model-thinking-trigger"));
  return screen.getByTestId("model-thinking-popover");
}

describe("ModelSelector agent section", () => {
  it("offers the same Agent heading for a pick and reports a role or none", async () => {
    const { onAgentChange } = setup({ kind: "pick", roles, value: undefined });
    const popover = await open();
    expect(within(popover).getByText("Agent · sets the system prompt")).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(within(popover).getByRole("button", { name: /planner/ }));
    expect(onAgentChange).toHaveBeenCalledWith("planner");
    await user.click(within(popover).getByRole("button", { name: /No agent/ }));
    expect(onAgentChange).toHaveBeenLastCalledWith(undefined);
  });

  it("keeps a current agent that is no longer offered selected, unavailable and not clickable", async () => {
    setup({ kind: "pick", roles, value: "deleted" });
    const popover = await open();
    const row = within(popover).getByText("deleted").closest("li")!;
    expect(row).toHaveAttribute("aria-current", "true");
    expect(row).toHaveAttribute("aria-disabled", "true");
    expect(row).toHaveTextContent("No longer available");
    expect(within(row).queryByRole("button")).toBeNull();
  });

  it("drops the unavailable row once another agent is selected", async () => {
    const { rerender } = setup({ kind: "pick", roles, value: "deleted" });
    expect(within(await open()).getByText("deleted")).toBeInTheDocument();

    // The pick is controlled by its caller: re-render with the next value.
    rerender(
      <ModelSelector
        models={models}
        selected={{ model: { provider: "anthropic", modelId: "claude-a" }, level: "off" }}
        agent={{ kind: "pick", roles, value: "planner", onChange: vi.fn() }}
        onModelChange={vi.fn()}
        onLevelChange={vi.fn()}
      />,
    );
    expect(screen.queryByText("deleted")).toBeNull();
  });

  it("shows a fixed agent read-only", async () => {
    setup({ kind: "fixed", name: "reviewer", description: roles[0]!.description });
    const popover = await open();
    expect(within(popover).getByText("Agent · fixed at creation")).toBeInTheDocument();
    expect(within(popover).queryByRole("button", { name: /No agent/ })).toBeNull();
    expect(within(popover).getByText("reviewer")).toBeInTheDocument();
  });
});
