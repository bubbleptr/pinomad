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

async function openMenu(testId: string): Promise<HTMLElement> {
  await userEvent.setup().click(screen.getByTestId(testId));
  return screen.findByRole("menu");
}

describe("ModelSelector model menu", () => {
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

  it("lists providers, each opening its models one level down", async () => {
    const { onModelChange } = renderPick("claude-a", "high");
    const menu = await openMenu("model-trigger");
    const providers = within(menu).getAllByRole("menuitem").map((item) => item.textContent);
    // The provider holding the pick names it.
    expect(providers).toEqual(["anthropicClaude A", "openai", "local"]);

    // The submenu takes no pointer events while its trigger's hover intent is pending.
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.click(within(menu).getByRole("menuitem", { name: /^openai/ }));
    await user.click(await screen.findByRole("menuitemradio", { name: "GPT B" }));
    expect(onModelChange).toHaveBeenCalledWith({ provider: "openai", modelId: "gpt-b" });
  });

  it("picks the level from its own menu, strongest first, only the model's levels", async () => {
    const { onLevelChange } = renderPick("gpt-b", "low");
    expect(screen.getByTestId("model-trigger")).not.toHaveTextContent("Low");
    expect(screen.getByTestId("thinking-trigger")).toHaveTextContent("Low");

    const menu = await openMenu("thinking-trigger");
    expect(within(menu).getAllByRole("menuitemradio").map((item) => item.textContent)).toEqual(["Medium", "Low", "Off"]);
    await userEvent.setup().click(within(menu).getByRole("menuitemradio", { name: "Medium" }));
    expect(onLevelChange).toHaveBeenCalledWith("medium");
  });

  it("has no Thinking menu for a model that can't reason", () => {
    renderPick("llama-c", "off");
    expect(screen.queryByTestId("thinking-trigger")).toBeNull();
  });
});

describe("ModelSelector agent menu", () => {
  it("picks a role or none", async () => {
    const { onAgentChange } = setup({ kind: "pick", roles, value: undefined });
    const user = userEvent.setup();
    await user.click(within(await openMenu("agent-trigger")).getByRole("menuitemradio", { name: /^planner/ }));
    expect(onAgentChange).toHaveBeenCalledWith("planner");
    await user.click(within(await openMenu("agent-trigger")).getByRole("menuitemradio", { name: /^No agent/ }));
    expect(onAgentChange).toHaveBeenLastCalledWith(undefined);
  });

  it("lists a role whose pinned model isn't offered, and a broken file, without letting them be picked", async () => {
    setup({
      kind: "pick",
      roles: [...roles, { name: "gone", description: "Pinned elsewhere", model: "nowhere/model-z", prompt: "" }],
      problems: [{ file: "drafty.md", reason: "description is required" }],
      value: undefined,
    });
    const menu = await openMenu("agent-trigger");
    const gone = within(menu).getByRole("menuitemradio", { name: /^gone/ });
    expect(gone).toHaveAttribute("aria-disabled", "true");
    expect(gone).toHaveTextContent("nowhere/model-z isn't available");
    expect(within(menu).getByRole("menuitemradio", { name: /^drafty\.md/ })).toHaveTextContent("description is required");
  });

  it("keeps a current agent that is no longer offered checked and unavailable", async () => {
    setup({ kind: "pick", roles, value: "deleted" });
    expect(screen.getByTestId("agent-trigger")).toHaveTextContent("@deleted");
    const row = within(await openMenu("agent-trigger")).getByRole("menuitemradio", { name: /^deleted/ });
    expect(row).toHaveAttribute("aria-checked", "true");
    expect(row).toHaveAttribute("aria-disabled", "true");
    expect(row).toHaveTextContent("No longer available");
  });

  it("drops the unavailable row once another agent is selected", async () => {
    const { rerender } = setup({ kind: "pick", roles, value: "deleted" });
    rerender(
      <ModelSelector
        models={models}
        selected={{ model: { provider: "anthropic", modelId: "claude-a" }, level: "off" }}
        agent={{ kind: "pick", roles, value: "planner", onChange: vi.fn() }}
        onModelChange={vi.fn()}
        onLevelChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId("agent-trigger")).toHaveTextContent("@planner");
    expect(within(await openMenu("agent-trigger")).queryByRole("menuitemradio", { name: /^deleted/ })).toBeNull();
  });

  it("shows a fixed agent as a disabled trigger", () => {
    setup({ kind: "fixed", name: "reviewer", description: roles[0]!.description });
    expect(screen.getByTestId("agent-trigger")).toHaveTextContent("@reviewer");
    expect(screen.getByTestId("agent-trigger")).toHaveAttribute("aria-disabled", "true");
  });
});

describe("ModelSelector agent locks", () => {
  function renderLocked(locked: { model: boolean; level: boolean }) {
    render(
      <ModelSelector
        models={models}
        selected={{ model: { provider: "openai", modelId: "gpt-b" }, level: "low" }}
        agent={{ kind: "pick", roles, value: "reviewer", onChange: vi.fn() }}
        locked={locked}
        onModelChange={vi.fn()}
        onLevelChange={vi.fn()}
      />,
    );
  }

  it("disables the side the agent pins and leaves the other one", () => {
    renderLocked({ model: true, level: false });
    expect(screen.getByTestId("model-trigger")).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByTestId("thinking-trigger")).not.toHaveAttribute("aria-disabled", "true");
  });

  it("disables a pinned level", () => {
    renderLocked({ model: false, level: true });
    expect(screen.getByTestId("model-trigger")).not.toHaveAttribute("aria-disabled", "true");
    expect(screen.getByTestId("thinking-trigger")).toHaveAttribute("aria-disabled", "true");
  });
});
