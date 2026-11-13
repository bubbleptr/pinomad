import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AgentRole } from "@pinomad/protocol/agents.ts";
import type { ModelSummary, ThinkingLevel } from "@pinomad/protocol/view.ts";
import { ModelSelector, type ModelSelectorAgent } from "./model-selector.tsx";

const models: readonly ModelSummary[] = [
  { provider: "anthropic", modelId: "claude-a", name: "Claude A", contextWindow: 200_000, thinkingLevels: ["off", "high"] },
  { provider: "openai", modelId: "gpt-b", name: "GPT B", contextWindow: 400_000, thinkingLevels: ["off", "low", "medium"] },
  { provider: "local", modelId: "llama-c", name: "Llama C", contextWindow: 128_000, thinkingLevels: ["off"] },
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
  await user.click(screen.getByTestId("model-trigger"));
  return screen.getByTestId("model-popover");
}

describe("ModelSelector split capsules", () => {
  function renderPick(model: string, level: ThinkingLevel) {
    const onModelChange = vi.fn();
    const onLevelChange = vi.fn();
    render(
      <ModelSelector
        models={models}
        selected={{ model: models.find((each) => each.modelId === model)!, level }}
        onModelChange={onModelChange}
        onLevelChange={onLevelChange}
      />,
    );
    return { onModelChange, onLevelChange };
  }

  it("lists models under one heading per provider, without a search box", async () => {
    const { onModelChange } = renderPick("claude-a", "high");
    const popover = await open();
    expect(within(popover).queryByRole("textbox")).toBeNull();
    const groups = within(popover).getAllByRole("group").map((group) => group.getAttribute("aria-label"));
    expect(groups).toEqual(["anthropic", "openai", "local"]);
    await userEvent.setup().click(within(popover).getByRole("button", { name: "GPT B" }));
    expect(onModelChange).toHaveBeenCalledWith({ provider: "openai", modelId: "gpt-b" });
  });

  it("keeps Thinking out of the model popover and picks the level from its own capsule", async () => {
    const { onLevelChange } = renderPick("gpt-b", "low");
    expect(screen.getByTestId("model-trigger")).not.toHaveTextContent("Low");
    const thinking = screen.getByTestId("thinking-trigger");
    expect(thinking).toHaveTextContent("Low");
    expect(within(await open()).queryByRole("group", { name: "Thinking" })).toBeNull();

    const user = userEvent.setup();
    await user.click(thinking);
    const levels = screen.getByRole("group", { name: "Thinking" });
    // Strongest first, only the selected model's levels.
    expect(within(levels).getAllByRole("button").map((button) => button.textContent)).toEqual(["Medium", "Low", "Off"]);
    await user.click(within(levels).getByRole("button", { name: "Medium" }));
    expect(onLevelChange).toHaveBeenCalledWith("medium");
  });

  it("has no Thinking capsule for a model that can't reason", () => {
    renderPick("llama-c", "off");
    expect(screen.queryByTestId("thinking-trigger")).toBeNull();
  });
});

async function openAgents(): Promise<HTMLElement> {
  const popover = await open();
  await userEvent.setup().click(within(popover).getByRole("button", { name: /^Agent:/ }));
  return within(screen.getByTestId("model-popover")).getByRole("group", { name: "Agent" });
}

describe("ModelSelector agent picker", () => {
  it("picks a role or none from the list one level down, then returns to the models", async () => {
    const { onAgentChange } = setup({ kind: "pick", roles, value: undefined });
    const popover = await open();
    expect(within(popover).getByRole("button", { name: "Agent: No agent" })).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(within(await openAgentsAgain()).getByRole("button", { name: /^planner/ }));
    expect(onAgentChange).toHaveBeenCalledWith("planner");
    expect(within(screen.getByTestId("model-popover")).getByRole("group", { name: "anthropic" })).toBeInTheDocument();

    await user.click(within(await openAgentsAgain()).getByRole("button", { name: /^No agent/ }));
    expect(onAgentChange).toHaveBeenLastCalledWith(undefined);
  });

  it("lists a role whose pinned model isn't offered, and a broken file, without letting them be picked", async () => {
    const { onAgentChange } = setup({
      kind: "pick",
      roles: [...roles, { name: "gone", description: "Pinned elsewhere", model: "nowhere/model-z", prompt: "" }],
      problems: [{ file: "drafty.md", reason: "description is required" }],
      value: undefined,
    });
    const list = await openAgents();
    const gone = within(list).getByText("gone").closest("li")!;
    expect(gone).toHaveAttribute("aria-disabled", "true");
    expect(gone).toHaveTextContent("nowhere/model-z isn't available");
    await userEvent.setup().click(within(gone).getByRole("button"));
    expect(onAgentChange).not.toHaveBeenCalled();
    expect(within(list).getByText("drafty.md").closest("li")).toHaveTextContent("description is required");
  });

  it("keeps a current agent that is no longer offered selected, unavailable and not clickable", async () => {
    setup({ kind: "pick", roles, value: "deleted" });
    const row = within(await openAgents()).getByText("deleted").closest("li")!;
    expect(row).toHaveAttribute("aria-current", "true");
    expect(row).toHaveAttribute("aria-disabled", "true");
    expect(row).toHaveTextContent("No longer available");
    expect(within(row).queryByRole("button")).toBeNull();
  });

  it("drops the unavailable row once another agent is selected", async () => {
    const { rerender } = setup({ kind: "pick", roles, value: "deleted" });
    expect(within(await openAgents()).getByText("deleted")).toBeInTheDocument();

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
    const row = within(popover).getByRole("group", { name: "Agent" });
    expect(row).toHaveTextContent("@reviewer");
    expect(row).toHaveTextContent("Fixed at creation");
    expect(within(popover).queryByRole("button", { name: /^Agent:/ })).toBeNull();
  });
});

async function openAgentsAgain(): Promise<HTMLElement> {
  await userEvent.setup().click(within(screen.getByTestId("model-popover")).getByRole("button", { name: /^Agent:/ }));
  return within(screen.getByTestId("model-popover")).getByRole("group", { name: "Agent" });
}

describe("ModelSelector agent locks", () => {
  function renderLocked(locked: { model: boolean; level: boolean }) {
    const onModelChange = vi.fn();
    const onLevelChange = vi.fn();
    render(
      <ModelSelector
        models={models}
        selected={{ model: { provider: "openai", modelId: "gpt-b" }, level: "low" }}
        agent={{ kind: "pick", roles, value: "reviewer", onChange: vi.fn() }}
        locked={locked}
        onModelChange={onModelChange}
        onLevelChange={onLevelChange}
      />,
    );
    return { onModelChange, onLevelChange };
  }

  it("reads 'from @agent' and keeps the pinned model unpickable", async () => {
    const { onModelChange } = renderLocked({ model: true, level: false });
    expect(screen.getByTestId("model-trigger")).toHaveTextContent("GPT Bfrom @reviewer");
    const popover = await open();
    expect(popover).toHaveTextContent("Set by @reviewer");
    expect(within(popover).getByRole("button", { name: "Claude A" })).toBeDisabled();
    expect(onModelChange).not.toHaveBeenCalled();
  });

  it("reads 'with @agent' when the agent pins nothing, and both sides stay pickable", async () => {
    const { onModelChange } = renderLocked({ model: false, level: false });
    expect(screen.getByTestId("model-trigger")).toHaveTextContent("GPT Bwith @reviewer");
    await userEvent.setup().click(within(await open()).getByRole("button", { name: "Claude A" }));
    expect(onModelChange).toHaveBeenCalled();
  });

  it("keeps a pinned level unpickable", async () => {
    renderLocked({ model: false, level: true });
    await userEvent.setup().click(screen.getByTestId("thinking-trigger"));
    const levels = screen.getByRole("group", { name: "Thinking" });
    expect(levels).toHaveTextContent("set by @reviewer");
    expect(within(levels).getByRole("button", { name: "Medium" })).toBeDisabled();
  });
});
