import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn, userEvent, within } from "storybook/test";
import type { AgentRole } from "@pinomad/protocol/agents.ts";
import type { ModelRef } from "@earendil-works/pi-durable";
import type { ModelSummary, ThinkingLevel } from "@pinomad/protocol/view.ts";
import { clampLevel, sameModel } from "@pinomad/client/model.ts";
import { useState } from "react";
import { Plus, ArrowUp } from "@/shared/ui/icons";
import { IconButton } from "../../shared/ui/icon-button.tsx";
import { ModelSelector } from "./model-selector.tsx";

const models: ModelSummary[] = [
  { provider: "anthropic", modelId: "claude-a", name: "Claude A", contextWindow: 200_000, thinkingLevels: ["off", "medium", "high"] },
  { provider: "anthropic", modelId: "claude-a-max", name: "Claude A Max", contextWindow: 1_000_000, thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"] },
  { provider: "openai", modelId: "gpt-b", name: "GPT B", contextWindow: 400_000, thinkingLevels: ["off", "low", "medium"] },
  { provider: "local", modelId: "llama-c", name: "Llama C", contextWindow: 128_000, thinkingLevels: ["off"] },
  // The maker's logo, not OpenRouter's; then a model with no logo at all, whose row keeps the logo slot.
  { provider: "openrouter", modelId: "moonshotai/kimi-d", name: "Kimi D", contextWindow: 256_000, thinkingLevels: ["off"] },
  { provider: "custom-lab", modelId: "house-e", name: "House E", contextWindow: 32_000, thinkingLevels: ["off"] },
];

const roles: AgentRole[] = [
  { name: "reviewer", description: "Reads the diff against the repo's ADRs and flags what breaks them.", model: "anthropic/claude-a", thinkingLevel: "high", prompt: "Be thorough." },
  { name: "planner", description: "Turns a request into an ordered plan before any code changes.", prompt: "Be concise." },
  { name: "release-notes", description: "Writes user-facing notes from merged PRs.", model: "gone/claude-z", prompt: "" },
];

const problems = [{ file: "drafty.md", reason: "description is required" }];

const open = async ({ canvasElement }: { canvasElement: HTMLElement }) => {
  await userEvent.click(within(canvasElement).getByTestId("model-trigger"));
};

const meta = {
  title: "Entities/Model/ModelSelector",
  component: ModelSelector,
  args: {
    models,
    selected: { model: { provider: "anthropic", modelId: "claude-a" }, level: "medium" },
    onModelChange: fn(),
    onLevelChange: fn(),
  },
} satisfies Meta<typeof ModelSelector>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Reasoning: Story = {};

export const NonReasoning: Story = {
  args: { selected: { model: { provider: "local", modelId: "llama-c" }, level: "off" } },
};


export const Problem: Story = {
  args: {
    problem: {
      label: "anthropic/claude-z unavailable",
      title: "anthropic/claude-z (@reviewer's model) is not in the host's model list",
    },
  },
};

export const NoModels: Story = {
  args: { models: [], selected: { level: "off" } },
};

export const Open: Story = { play: open };

/** The Thinking capsule's popover: the selected model's levels, strongest first. */
export const ThinkingOpen: Story = {
  args: { selected: { model: { provider: "anthropic", modelId: "claude-a-max" }, level: "high" } },
  play: async (context) => {
    await open(context);
    await userEvent.click(await within(document.body).findByRole("menuitem", { name: /^Thinking/ }));
  },
};

const openAgents = async (context: { canvasElement: HTMLElement }) => {
  await open(context);
  await userEvent.click(await within(document.body).findByRole("menuitem", { name: /^Agent/ }));
};

/** A draft on a host with named agents: the Agent menu comes first, just its icon while none is picked. */
export const AgentPick: Story = {
  args: { agent: { kind: "pick", roles, problems, value: undefined, onChange: fn() } },
};

/** The agent menu: pins, an unavailable model and a broken file. */
export const AgentList: Story = { ...AgentPick, play: openAgents };

/** An agent that pins model and level: both disabled, "Set by @name" on hover. */
export const AgentPicked: Story = {
  args: {
    agent: { kind: "pick", roles, problems, value: "reviewer", onChange: fn() },
    selected: { model: { provider: "anthropic", modelId: "claude-a" }, level: "high" },
    locked: { model: true, level: true },
  },
};


/** An agent that pins nothing: both sides stay the user's. */
export const AgentUnpinned: Story = {
  args: { agent: { kind: "pick", roles, value: "planner", onChange: fn() } },
};

/** A conversation on a 5.18 host: the current agent is picked like a draft's. */
export const ConversationAgentPick: Story = {
  args: { agent: { kind: "pick", roles, value: "reviewer", onChange: fn() } },
  play: openAgents,
};

/** The conversation's current agent file is gone: still shown as selected, not offered again. */
export const ConversationAgentMissing: Story = {
  args: { agent: { kind: "pick", roles, value: "retired", onChange: fn() } },
  play: openAgents,
};

/** A pre-5.18 host has no setAgent: the creation agent is a disabled trigger. */
export const FixedRole: Story = {
  args: { agent: { kind: "fixed", name: "reviewer", description: roles[0]!.description } },
};

// ── Playground: every pick works, wired like the draft composer ─────────────

const playgroundModels: ModelSummary[] = [
  { provider: "anthropic", modelId: "claude-opus-5-5", name: "Claude Opus 5.5", contextWindow: 1_000_000, thinkingLevels: ["off", "low", "medium", "high", "xhigh", "max"] },
  { provider: "anthropic", modelId: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", contextWindow: 1_000_000, thinkingLevels: ["off", "low", "medium", "high", "max"] },
  { provider: "anthropic", modelId: "claude-haiku-5-5", name: "Claude Haiku 5.5", contextWindow: 200_000, thinkingLevels: ["off", "high"] },
  { provider: "openai", modelId: "gpt-6", name: "GPT-6", contextWindow: 400_000, thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"] },
  { provider: "openai", modelId: "o3", name: "o3", contextWindow: 200_000, thinkingLevels: ["low", "medium", "high"] },
  { provider: "openai", modelId: "o4-mini", name: "o4-mini", contextWindow: 200_000, thinkingLevels: ["low", "medium", "high"] },
  { provider: "moonshot", modelId: "kimi-k3", name: "Kimi K3", contextWindow: 256_000, thinkingLevels: ["off", "low", "high", "max"] },
  { provider: "google", modelId: "gemini-3-pro", name: "Gemini 3 Pro", contextWindow: 2_000_000, thinkingLevels: ["low", "high"] },
  { provider: "ollama", modelId: "llama-5-70b", name: "Llama 5 70B", contextWindow: 128_000, thinkingLevels: ["off"] },
];

const playgroundRoles: AgentRole[] = [
  { name: "reviewer", description: "Reads the diff against the repo's ADRs and flags what breaks them.", model: "anthropic/claude-opus-5-5", thinkingLevel: "high", prompt: "" },
  { name: "planner", description: "Turns a request into an ordered plan before any code changes.", prompt: "" },
  { name: "fast-fix", description: "Small, quick edits.", model: "openai/o4-mini", prompt: "" },
  { name: "release-notes", description: "Writes user-facing notes from merged PRs.", model: "gone/claude-z", prompt: "" },
];

const toRef = (pinned: string): ModelRef => {
  const slash = pinned.indexOf("/");
  return { provider: pinned.slice(0, slash), modelId: pinned.slice(slash + 1) };
};

/**
 * The draft composer's rules in miniature: the level is kept as picked and
 * clamped per model; an agent's pins win and lock that side; the side it
 * doesn't pin stays the user's until the agent changes.
 */
function Playground() {
  const [model, setModel] = useState<ModelRef>({ provider: "openai", modelId: "gpt-6" });
  const [level, setLevel] = useState<ThinkingLevel>("high");
  const [agent, setAgent] = useState<string | undefined>(undefined);
  const [override, setOverride] = useState<{ model?: ModelRef; level?: ThinkingLevel }>({});
  const role = playgroundRoles.find((each) => each.name === agent);
  const shownModel = role?.model !== undefined ? toRef(role.model) : (override.model ?? model);
  const levels = playgroundModels.find((each) => sameModel(each, shownModel))?.thinkingLevels ?? ["off"];
  const shownLevel = clampLevel(levels, role?.thinkingLevel ?? override.level ?? level);
  const locked = { model: role?.model !== undefined, level: role?.thinkingLevel !== undefined };
  return (
    <div className="flex min-h-[90vh] flex-col justify-end gap-3 p-6">
      <div className="w-full max-w-[44rem] rounded-2xl bg-card p-3 shadow-[0_0_0_1px_var(--border),0_2px_8px_oklch(0_0_0/6%)]">
        <p className="px-1 pb-6 text-muted-foreground">Do anything with Pinomad</p>
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1">
            <IconButton label="More actions" icon={<Plus />} />
            <ModelSelector
              models={playgroundModels}
              selected={{ model: shownModel, level: shownLevel }}
              agent={{ kind: "pick", roles: playgroundRoles, problems: [{ file: "drafty.md", reason: "description is required" }], value: agent, onChange: (next) => {
                  setAgent(next);
                  setOverride({});
                },
              }}
              locked={locked}
              onModelChange={(next) => (agent === undefined ? setModel(next) : setOverride((current) => ({ ...current, model: next })))}
              onLevelChange={(next) => (agent === undefined ? setLevel(next) : setOverride((current) => ({ ...current, level: next })))}
            />
          </div>
          <IconButton label="Send" variant="primary" icon={<ArrowUp />} />
        </div>
      </div>
      <p className="px-1 text-xs text-muted-foreground tabular-nums">
        Sends {shownModel.provider}/{shownModel.modelId} · {shownLevel}
        {agent === undefined ? "" : ` · @${agent}`} — picked level: {level}
      </p>
    </div>
  );
}

/** Every interaction works here: switch models and levels, pick or clear an agent, try a locked side. */
export const Playground_: Story = {
  name: "Playground",
  parameters: { canvasWidth: "full" },
  render: () => <Playground />,
};
