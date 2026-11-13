// Simplified port of Pace's ModelSelectorControl
// (entities/model/model-selector/model-selector-control.tsx, PiGUI commit
// 15b9084), split into three menus — agent, model, thinking — without fast
// mode, the image badge or Settings management. The named agent (ADR-0023)
// is part of the same pick (issue #254): a role is a model-level preset —
// model, thinking level and system prompt — so it sits first in the row.
import type { ReactElement, ReactNode } from "react";
import { cn } from "cn";
import { Button } from "../../shared/ui/button.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../shared/ui/tooltip.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../../shared/ui/dropdown-menu.tsx";
import type { ModelRef } from "@earendil-works/pi-durable";
import type { AgentRole, AgentRoleProblem } from "@pinomad/protocol/agents.ts";
import type { ModelSummary, ThinkingLevel } from "@pinomad/protocol/view.ts";
import { sameModel, thinkingLevelLabels } from "@pinomad/client/model.ts";
import { Bot, ChevronDown } from "@/shared/ui/icons";
import { ModelLogo } from "./model-logo.tsx";

/**
 * The Agent menu: a draft or a 5.18 conversation picks one of the host's
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
 * The composer's three pickers, side by side: the agent (`@name`, or just
 * its icon when there is none), the model (`<logo> <name>`, opening its
 * providers, each with its models one level down), and — when the model can
 * reason — the thinking level (`<meter> <level>`). A side the agent pins is
 * shown but disabled, with "Set by @name" as its tooltip.
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
  /** Undefined hides the Agent menu (nothing to show: no pick, and no fixed creation agent). */
  agent?: ModelSelectorAgent;
  /** The sides the current agent pins: shown, but not pickable. */
  locked?: { readonly model: boolean; readonly level: boolean };
  /** Why the shown pick can't be sent — rendered in red instead of the model, with no Thinking menu. */
  problem?: { readonly label: string; readonly title: string };
  onModelChange: (model: ModelRef) => void;
  onLevelChange: (level: ThinkingLevel) => void;
}) {
  const selectedSummary = models.find((each) => sameModel(each, selected.model));
  const levels = selectedSummary?.thinkingLevels ?? ["off"];
  const agentName = agent === undefined ? undefined : agent.kind === "pick" ? agent.value : agent.name;
  const disabled = isDisabled || models.length === 0;
  const lockNote = agentName === undefined ? undefined : `Set by @${agentName}`;
  const groups = groupByProvider(models);
  const pickModel = (key: string) => {
    const model = models.find((each) => modelKey(each) === key);
    if (model !== undefined) onModelChange({ provider: model.provider, modelId: model.modelId });
  };
  const modelItems = (list: readonly ModelSummary[]) => (
    <DropdownMenuRadioGroup value={selected.model === undefined ? null : modelKey(selected.model)} onValueChange={pickModel}>
      {list.map((model) => (
        <DropdownMenuRadioItem key={modelKey(model)} value={modelKey(model)} disabled={isDisabled}>
          <ModelLogo model={model} reserve />
          <span className="truncate">{model.name}</span>
        </DropdownMenuRadioItem>
      ))}
    </DropdownMenuRadioGroup>
  );

  return (
    <span className="flex min-w-0 max-w-[26rem] items-center">
      {agent === undefined ? null : <AgentMenu agent={agent} models={models} isDisabled={disabled} />}
      <DropdownMenu>
        <WithTooltip tip={problem !== undefined ? problem.title : locked.model ? lockNote : undefined}>
        <DropdownMenuTrigger
          render={
            <Button
              className="min-w-0 shrink flex-nowrap gap-1.5 px-2 text-muted-foreground"
              data-testid="model-trigger"
              disabled={disabled || (locked.model && problem === undefined)}
              focusableWhenDisabled
              aria-label="Model"
              size="md"
              variant="ghost"
            />
          }
        >
          {problem === undefined && selected.model !== undefined ? <ModelLogo model={selected.model} size={14} /> : null}
          {problem === undefined ? (
            <span className="truncate">{selectedSummary?.name ?? selected.model?.modelId ?? "No model"}</span>
          ) : (
            <span className="truncate text-destructive">{problem.label}</span>
          )}
          {locked.model ? null : <ChevronDown aria-hidden="true" strokeWidth={2} className="size-4" />}
        </DropdownMenuTrigger>
        </WithTooltip>
        <DropdownMenuContent aria-label="Model" side="top" className="w-56">
          {groups.length === 1
            ? modelItems(groups[0]!.models)
            : groups.map((group) => (
                <DropdownMenuSub key={group.provider}>
                  <DropdownMenuSubTrigger>
                    <ModelLogo model={group.models[0]!} reserve />
                    <span className="truncate">{group.provider}</span>
                    {group.models.some((model) => sameModel(model, selected.model)) ? (
                      <span className="ms-auto truncate ps-2 text-xs text-muted-foreground">{selectedSummary?.name}</span>
                    ) : null}
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent aria-label={group.provider} className="w-56">
                    {modelItems(group.models)}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {problem !== undefined || levels.length < 2 ? null : (
        <DropdownMenu>
          <WithTooltip tip={locked.level ? lockNote : undefined}>
          <DropdownMenuTrigger
            render={
              <Button
                className="shrink-0 gap-1.5 px-2 text-muted-foreground"
                data-testid="thinking-trigger"
                disabled={disabled || locked.level}
                focusableWhenDisabled
                aria-label={`Thinking: ${thinkingLevelLabels[selected.level]}`}
                size="md"
                variant="ghost"
              />
            }
          >
            <LevelMeter levels={levels} level={selected.level} />
            {thinkingLevelLabels[selected.level]}
          </DropdownMenuTrigger>
          </WithTooltip>
          <DropdownMenuContent aria-label="Thinking" side="top" className="w-44">
            <DropdownMenuGroup>
              <DropdownMenuLabel>Thinking</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={selected.level} onValueChange={(level: ThinkingLevel) => onLevelChange(level)}>
                {[...levels].reverse().map((level) => (
                  <DropdownMenuRadioItem key={level} value={level} disabled={isDisabled}>
                    <LevelMeter levels={levels} level={level} className="text-muted-foreground" />
                    {thinkingLevelLabels[level]}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </span>
  );
}

/**
 * A tooltip around a menu trigger. Button's own `tooltip` wraps the button in
 * a Tooltip root, which a menu trigger can't render into, so it goes outside.
 */
function WithTooltip({ tip, children }: { tip: string | undefined; children: ReactElement }) {
  if (tip === undefined) return children;
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
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
 * The Agent menu: No agent, then each role with what it pins (or its
 * description). A role whose pinned model the host doesn't offer, a role file
 * the host couldn't read, and a current agent that's gone are listed but not
 * pickable. A fixed agent is a disabled trigger.
 */
function AgentMenu({ agent, models, isDisabled }: { agent: ModelSelectorAgent; models: readonly ModelSummary[]; isDisabled: boolean }) {
  const name = agent.kind === "pick" ? agent.value : agent.name;
  const tooltip =
    agent.kind === "fixed"
      ? `@${agent.name} · fixed at creation`
      : name === undefined
        ? "Agent"
        : (agent.roles.find((role) => role.name === name)?.description ?? "No longer available");
  const trigger = (
    <Button
      className={cn("shrink-0 gap-1.5 text-muted-foreground", name === undefined ? "px-1.5" : "px-2")}
      data-testid="agent-trigger"
      disabled={isDisabled || agent.kind === "fixed"}
      focusableWhenDisabled
      aria-label="Agent"
      size="md"
      variant="ghost"
    />
  );
  const label = (
    <>
      <Bot aria-hidden="true" className="size-4" />
      {name === undefined ? null : <span className="max-w-[8rem] truncate">@{name}</span>}
    </>
  );
  if (agent.kind === "fixed") {
    return (
      <DropdownMenu disabled>
        <WithTooltip tip={tooltip}>
          <DropdownMenuTrigger render={trigger}>{label}</DropdownMenuTrigger>
        </WithTooltip>
      </DropdownMenu>
    );
  }
  const missing = name !== undefined && !agent.roles.some((role) => role.name === name) ? name : undefined;
  const problems = agent.problems ?? [];
  return (
    <DropdownMenu>
      <WithTooltip tip={tooltip}>
        <DropdownMenuTrigger render={trigger}>{label}</DropdownMenuTrigger>
      </WithTooltip>
      <DropdownMenuContent aria-label="Agent" side="top" className="max-h-[min(440px,var(--available-height))] w-64">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Agent · sets the system prompt</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={name ?? NO_AGENT}
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
        </DropdownMenuGroup>
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
      </DropdownMenuContent>
    </DropdownMenu>
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
