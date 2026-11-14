// Simplified port of Pace's ModelSelectorControl
// (entities/model/model-selector/model-selector-control.tsx, PiGUI commit
// 15b9084): one capsule whose menu has a row each for the agent, the model
// and the thinking level, each opening its choices one level down on hover —
// without fast mode, the image badge or Settings management. The named agent
// (ADR-0023) is part of the same pick (issue #254): a role is a model-level
// preset — model, thinking level and system prompt.
import { Fragment, type ReactNode } from "react";
import { cn } from "cn";
import { Button } from "../../shared/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../../shared/ui/dropdown-menu.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../shared/ui/tooltip.tsx";
import type { ModelRef } from "@earendil-works/pi-durable";
import type { AgentRole, AgentRoleProblem } from "@pinomad/protocol/agents.ts";
import type { ModelSummary, ThinkingLevel } from "@pinomad/protocol/view.ts";
import { sameModel, thinkingLevelLabels } from "@pinomad/client/model.ts";
import { Bot, Brain, ChevronDown } from "@/shared/ui/icons";
import { ModelLogo } from "./model-logo.tsx";

/**
 * The Agent row: a draft or a 5.18 conversation picks one of the host's
 * roles (or none); before 5.18 a conversation shows the role it was created
 * with, read-only (ADR-0023).
 */
export type ModelSelectorAgent =
  | {
      readonly kind: "pick";
      readonly roles: readonly AgentRole[];
      /** Role files the host couldn't read: listed, not pickable. */
      readonly problems?: readonly AgentRoleProblem[];
      /** The picked role's name, undefined for "No agent". */
      readonly value?: string;
      readonly onChange: (agent: string | undefined) => void;
    }
  | { readonly kind: "fixed"; readonly name: string; readonly description?: string };

/**
 * The composer capsule: `<logo> [@agent · ]<model>[ · <level>]`, opening a
 * menu with an Agent, a Model and (for a model that can reason) a Thinking
 * row. Each row shows its current value and opens its choices beside it on
 * hover. A side the agent pins is shown but its row is disabled.
 */
export function ModelSelector({
  models,
  selected,
  isDisabled = false,
  agent,
  locked = { model: false, level: false },
  problem,
  onModelChange,
  onLevelChange,
}: {
  models: readonly ModelSummary[];
  selected: { model?: ModelRef; level: ThinkingLevel };
  isDisabled?: boolean;
  /** Undefined hides the Agent row (nothing to show: no pick, and no fixed creation agent). */
  agent?: ModelSelectorAgent;
  /** The sides the current agent pins: shown, but not pickable. */
  locked?: { readonly model: boolean; readonly level: boolean };
  /** Why the shown pick can't be sent — rendered in red instead of the label. */
  problem?: { readonly label: string; readonly title: string };
  onModelChange: (model: ModelRef) => void;
  onLevelChange: (level: ThinkingLevel) => void;
}) {
  const selectedSummary = models.find((each) => sameModel(each, selected.model));
  const levels = selectedSummary?.thinkingLevels ?? ["off"];
  const reasons = levels.length > 1;
  const agentName = agent === undefined ? undefined : agent.kind === "pick" ? agent.value : agent.name;
  const modelName = selectedSummary?.name ?? selected.model?.modelId ?? "No model";
  const lockNote = agentName === undefined ? undefined : `Set by @${agentName}`;
  const label = [agentName === undefined ? undefined : `@${agentName}`, modelName, reasons ? thinkingLevelLabels[selected.level] : undefined]
    .filter((part) => part !== undefined)
    .join(" · ");

  const trigger = (
    <DropdownMenuTrigger
      render={
        <Button
          className="min-w-0 max-w-[19rem] flex-nowrap gap-1.5 px-2 text-muted-foreground"
          data-testid="model-trigger"
          disabled={isDisabled || models.length === 0}
          focusableWhenDisabled
          aria-label="Model and Thinking"
          size="md"
          variant="ghost"
        />
      }
    >
      {problem === undefined && selected.model !== undefined ? <ModelLogo model={selected.model} size={14} /> : null}
      {problem === undefined ? <span className="truncate">{label}</span> : <span className="truncate text-destructive">{problem.label}</span>}
      {/* The Select trigger's glyph, so it matches the draft tray's pickers. */}
      <ChevronDown aria-hidden="true" strokeWidth={2} className="size-4" />
    </DropdownMenuTrigger>
  );

  return (
    <DropdownMenu>
      {problem === undefined ? (
        trigger
      ) : (
        <Tooltip>
          <TooltipTrigger render={trigger} />
          <TooltipContent>{problem.title}</TooltipContent>
        </Tooltip>
      )}
      <DropdownMenuContent aria-label="Model and Thinking" side="top" className="w-60">
        {agent === undefined ? null : (
          <DropdownMenuSub>
            <Row
              icon={<Bot aria-hidden="true" />}
              label="Agent"
              value={agentName === undefined ? "None" : `@${agentName}`}
              disabled={isDisabled || agent.kind === "fixed"}
              {...(agent.kind === "fixed" ? { note: "Fixed at creation" } : {})}
            />
            {agent.kind === "pick" ? <AgentChoices agent={agent} models={models} isDisabled={isDisabled} /> : null}
          </DropdownMenuSub>
        )}
        <DropdownMenuSub>
          <Row
            icon={selected.model === undefined ? <Bot aria-hidden="true" /> : <ModelLogo model={selected.model} reserve />}
            label="Model"
            value={modelName}
            disabled={isDisabled || locked.model}
            {...(locked.model && lockNote !== undefined ? { note: lockNote } : {})}
          />
          <DropdownMenuSubContent aria-label="Model" className="w-56">
            <DropdownMenuRadioGroup
              value={selected.model === undefined ? null : modelKey(selected.model)}
              onValueChange={(key: string) => {
                const model = models.find((each) => modelKey(each) === key);
                if (model !== undefined) onModelChange({ provider: model.provider, modelId: model.modelId });
              }}
            >
              {groupByProvider(models).map((group, index) => (
                <Fragment key={group.provider}>
                  {index === 0 ? null : <DropdownMenuSeparator />}
                  {group.models.map((model) => (
                    <DropdownMenuRadioItem key={modelKey(model)} value={modelKey(model)} disabled={isDisabled}>
                      <ModelLogo model={model} reserve />
                      <span className="truncate">{model.name}</span>
                    </DropdownMenuRadioItem>
                  ))}
                </Fragment>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        {problem !== undefined || !reasons ? null : (
          <DropdownMenuSub>
            <Row
              icon={<Brain aria-hidden="true" />}
              label="Thinking"
              value={thinkingLevelLabels[selected.level]}
              disabled={isDisabled || locked.level}
              {...(locked.level && lockNote !== undefined ? { note: lockNote } : {})}
            />
            <DropdownMenuSubContent aria-label="Thinking" className="w-44">
              <DropdownMenuRadioGroup value={selected.level} onValueChange={(level: ThinkingLevel) => onLevelChange(level)}>
                {[...levels].reverse().map((level) => (
                  <DropdownMenuRadioItem key={level} value={level} disabled={isDisabled}>
                    <LevelMeter levels={levels} level={level} className="text-muted-foreground" />
                    {thinkingLevelLabels[level]}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * A first-level row: icon, label, the current value on the right. Locked or
 * fixed rows say why under the label and don't open.
 */
function Row({ icon, label, value, note, disabled }: { icon: ReactNode; label: string; value: string; note?: string; disabled: boolean }) {
  return (
    <DropdownMenuSubTrigger disabled={disabled} label={label} className="gap-2">
      <span className="flex size-4 items-center justify-center text-muted-foreground">{icon}</span>
      <span className="flex min-w-0 flex-col">
        <span>{label}</span>
        {note === undefined ? null : <span className="truncate text-xs text-muted-foreground">{note}</span>}
      </span>
      <span className="ms-auto min-w-0 truncate ps-2 text-xs text-muted-foreground">{value}</span>
    </DropdownMenuSubTrigger>
  );
}

const modelKey = (model: ModelRef): string => `${model.provider}/${model.modelId}`;

function groupByProvider(models: readonly ModelSummary[]): { provider: string; models: ModelSummary[] }[] {
  const groups = new Map<string, ModelSummary[]>();
  for (const model of models) groups.set(model.provider, [...(groups.get(model.provider) ?? []), model]);
  return [...groups].map(([provider, list]) => ({ provider, models: list }));
}

const NO_AGENT = "";

/**
 * The agent choices: No agent, then each role with what it pins (or its
 * description). A role whose pinned model the host doesn't offer, a role file
 * the host couldn't read, and a current agent that's gone are listed but not
 * pickable.
 */
function AgentChoices({
  agent,
  models,
  isDisabled,
}: {
  agent: Extract<ModelSelectorAgent, { kind: "pick" }>;
  models: readonly ModelSummary[];
  isDisabled: boolean;
}) {
  const missing = agent.value !== undefined && !agent.roles.some((role) => role.name === agent.value) ? agent.value : undefined;
  const problems = agent.problems ?? [];
  return (
    <DropdownMenuSubContent aria-label="Agent" className="max-h-[min(440px,var(--available-height))] w-64">
      <DropdownMenuRadioGroup
        value={agent.value ?? NO_AGENT}
        onValueChange={(value: string) => agent.onChange(value === NO_AGENT ? undefined : value)}
      >
        {missing === undefined ? null : (
          <AgentItem value={missing} title={missing} detail="No longer available" tone="destructive" disabled media={<Bot aria-hidden="true" />} />
        )}
        <AgentItem
          value={NO_AGENT}
          title="No agent"
          detail="Default system prompt"
          disabled={isDisabled}
          media={<Bot aria-hidden="true" className="text-muted-foreground" />}
        />
        {agent.roles.map((role) => {
          const pinned = role.model === undefined ? undefined : models.find((model) => modelKey(model) === role.model);
          const unavailable = role.model !== undefined && pinned === undefined;
          return (
            <AgentItem
              key={role.name}
              value={role.name}
              title={role.name}
              detail={unavailable ? `${role.model} isn't available` : (pinnedLabel(pinned, role.thinkingLevel) ?? role.description)}
              hint={role.description}
              {...(unavailable ? { tone: "destructive" as const } : {})}
              disabled={isDisabled || unavailable}
              media={pinned === undefined ? <Bot aria-hidden="true" className="text-muted-foreground" /> : <ModelLogo model={pinned} reserve />}
            />
          );
        })}
      </DropdownMenuRadioGroup>
      {problems.length === 0 ? null : (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuRadioGroup value={null}>
            {problems.map((broken) => (
              <AgentItem
                key={broken.file}
                value={`file:${broken.file}`}
                title={broken.file}
                detail={broken.reason}
                tone="destructive"
                disabled
                media={<Bot aria-hidden="true" className="text-muted-foreground" />}
              />
            ))}
          </DropdownMenuRadioGroup>
        </>
      )}
    </DropdownMenuSubContent>
  );
}

/** One agent: name over a one-line detail, the whole description as its tooltip. */
function AgentItem({
  value,
  title,
  detail,
  hint,
  tone,
  disabled = false,
  media,
}: {
  value: string;
  title: string;
  detail: string;
  hint?: string;
  tone?: "destructive";
  disabled?: boolean;
  media: ReactNode;
}) {
  return (
    <DropdownMenuRadioItem value={value} disabled={disabled} title={hint} label={title}>
      <span className="flex size-4 items-center justify-center self-start pt-1">{media}</span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate">{title}</span>
        <span className={cn("truncate text-xs", tone === "destructive" ? "text-destructive" : "text-muted-foreground")}>{detail}</span>
      </span>
    </DropdownMenuRadioItem>
  );
}

/** "Claude Opus 5.5 · High" for what a role pins, undefined when it pins neither. */
function pinnedLabel(model: ModelSummary | undefined, level: ThinkingLevel | undefined): string | undefined {
  const parts = [model?.name, level === undefined ? undefined : thinkingLevelLabels[level]].filter((part) => part !== undefined);
  return parts.length === 0 ? undefined : parts.join(" · ");
}

/**
 * Signal-strength bars for a level among the model's levels: one bar per
 * level above Off (at least three, so a one-level model still reads as a
 * meter); Off lights none, the strongest lights all.
 */
function LevelMeter({ levels, level, className }: { levels: readonly ThinkingLevel[]; level: ThinkingLevel; className?: string }) {
  const steps: readonly ThinkingLevel[] = levels.filter((each) => each !== "off");
  const bars = Math.max(steps.length, 3);
  const lit = steps.length === 0 ? 0 : Math.round(((steps.indexOf(level) + 1) / steps.length) * bars);
  return (
    <span aria-hidden="true" className={cn("inline-flex h-3.5 shrink-0 items-end gap-px", className)}>
      {Array.from({ length: bars }, (_, index) => (
        <span
          key={index}
          className={cn("w-[2.5px] rounded-full bg-current", index < lit ? undefined : "opacity-20")}
          style={{ height: `${35 + (65 * index) / (bars - 1)}%` }}
        />
      ))}
    </span>
  );
}
