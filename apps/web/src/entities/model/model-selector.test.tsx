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

/** Opens the capsule's menu, then the named row's submenu; returns that submenu. */
async function openSub(row: "Agent" | "Model" | "Thinking"): Promise<HTMLElement> {
  // A submenu takes no pointer events while its row's hover intent is pending.
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  await user.click(screen.getByTestId("model-trigger"));
  const menu = await screen.findByRole("menu", { name: "Model and Thinking" });
  await user.click(within(menu).getByRole("menuitem", { name: new RegExp(`^${row}`) }));
  return screen.findByRole("menu", { name: row });
}

const click = (element: HTMLElement) => userEvent.setup({ pointerEventsCheck: 0 }).click(element);

describe("ModelSelector", () => {
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

  it("labels the capsule with the model and level, and lists every model in one submenu", async () => {
    const { onModelChange } = renderPick("claude-a", "high");
    expect(screen.getByTestId("model-trigger")).toHaveTextContent("Claude A · High");
    const sub = await openSub("Model");
    expect(within(sub).getAllByRole("menuitemradio").map((item) => item.textContent)).toEqual(["Claude A", "GPT B", "Llama C"]);
    // One separator between each provider's models.
    expect(within(sub).getAllByRole("separator")).toHaveLength(2);
    await click(within(sub).getByRole("menuitemradio", { name: "GPT B" }));
    expect(onModelChange).toHaveBeenCalledWith({ provider: "openai", modelId: "gpt-b" });
  });

  it("picks the level from the Thinking submenu, strongest first, only the model's levels", async () => {
    const { onLevelChange } = renderPick("gpt-b", "low");
    const sub = await openSub("Thinking");
    expect(within(sub).getAllByRole("menuitemradio").map((item) => item.textContent)).toEqual(["Medium", "Low", "Off"]);
    await click(within(sub).getByRole("menuitemradio", { name: "Medium" }));
    expect(onLevelChange).toHaveBeenCalledWith("medium");
  });

  it("names the provider only on models whose name another provider also serves", async () => {
    const shared: readonly ModelSummary[] = [
      ...models,
      { provider: "github-copilot", modelId: "gpt-b", name: "GPT B", contextWindow: 128_000, thinkingLevels: ["off"] },
    ];
    const onModelChange = vi.fn();
    render(
      <ModelSelector
        models={shared}
        selected={{ model: { provider: "anthropic", modelId: "claude-a" }, level: "off" }}
        onModelChange={onModelChange}
        onLevelChange={vi.fn()}
      />,
    );
    const sub = await openSub("Model");
    expect(within(sub).getAllByRole("menuitemradio").map((item) => item.textContent)).toEqual([
      "Claude A",
      "GPT Bopenai",
      "Llama C",
      "GPT Bgithub-copilot",
    ]);
    await click(within(sub).getByRole("menuitemradio", { name: "GPT B github-copilot" }));
    expect(onModelChange).toHaveBeenCalledWith({ provider: "github-copilot", modelId: "gpt-b" });
  });

  it("has no Thinking row for a model that can't reason", async () => {
    renderPick("llama-c", "off");
    expect(screen.getByTestId("model-trigger")).toHaveTextContent(/^Llama C$/);
    await userEvent.setup().click(screen.getByTestId("model-trigger"));
    const menu = await screen.findByRole("menu", { name: "Model and Thinking" });
    expect(within(menu).queryByRole("menuitem", { name: /^Thinking/ })).toBeNull();
  });
});

describe("ModelSelector agent row", () => {
  it("picks a role or none", async () => {
    const { onAgentChange } = setup({ kind: "pick", roles, value: undefined });
    await click(within(await openSub("Agent")).getByRole("menuitemradio", { name: /^planner/ }));
    expect(onAgentChange).toHaveBeenCalledWith("planner");
    await click(within(await openSub("Agent")).getByRole("menuitemradio", { name: /^No agent/ }));
    expect(onAgentChange).toHaveBeenLastCalledWith(undefined);
  });

  it("lists a role whose pinned model isn't offered, and a broken file, without letting them be picked", async () => {
    setup({
      kind: "pick",
      roles: [...roles, { name: "gone", description: "Pinned elsewhere", model: "nowhere/model-z", prompt: "" }],
      problems: [{ file: "drafty.md", reason: "description is required" }],
      value: undefined,
    });
    const sub = await openSub("Agent");
    const gone = within(sub).getByRole("menuitemradio", { name: /^gone/ });
    expect(gone).toHaveAttribute("aria-disabled", "true");
    expect(gone).toHaveTextContent("nowhere/model-z isn't available");
    expect(within(sub).getByRole("menuitemradio", { name: /^drafty\.md/ })).toHaveTextContent("description is required");
  });

  it("keeps a current agent that is no longer offered checked and unavailable", async () => {
    setup({ kind: "pick", roles, value: "deleted" });
    expect(screen.getByTestId("model-trigger")).toHaveTextContent("@deleted · Claude A");
    const row = within(await openSub("Agent")).getByRole("menuitemradio", { name: /^deleted/ });
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
    expect(within(await openSub("Agent")).queryByRole("menuitemradio", { name: /^deleted/ })).toBeNull();
  });

  it("shows a fixed agent as a row that doesn't open", async () => {
    setup({ kind: "fixed", name: "reviewer", description: roles[0]!.description });
    await userEvent.setup().click(screen.getByTestId("model-trigger"));
    const row = within(await screen.findByRole("menu", { name: "Model and Thinking" })).getByRole("menuitem", { name: /^Agent/ });
    expect(row).toHaveTextContent("@reviewer");
    expect(row).toHaveTextContent("Fixed at creation");
    expect(row).toHaveAttribute("aria-disabled", "true");
  });
});

describe("ModelSelector agent locks", () => {
  async function openLocked(locked: { model: boolean; level: boolean }): Promise<HTMLElement> {
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
    await userEvent.setup().click(screen.getByTestId("model-trigger"));
    return screen.findByRole("menu", { name: "Model and Thinking" });
  }

  it("disables the row the agent pins, says why, and leaves the other one", async () => {
    const menu = await openLocked({ model: true, level: false });
    const model = within(menu).getByRole("menuitem", { name: /^Model/ });
    expect(model).toHaveAttribute("aria-disabled", "true");
    expect(model).toHaveTextContent("Set by @reviewer");
    expect(within(menu).getByRole("menuitem", { name: /^Thinking/ })).not.toHaveAttribute("aria-disabled", "true");
  });

  it("disables a pinned level", async () => {
    const menu = await openLocked({ model: false, level: true });
    expect(within(menu).getByRole("menuitem", { name: /^Model/ })).not.toHaveAttribute("aria-disabled", "true");
    expect(within(menu).getByRole("menuitem", { name: /^Thinking/ })).toHaveAttribute("aria-disabled", "true");
  });
});
