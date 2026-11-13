// Simplified port of Pace's ModelSelectorControl
// (entities/model/model-selector/model-selector-control.tsx, PiGUI commit
// 15b9084), split in two: the model capsule opens the agent and the models
// grouped by provider, and a thinking capsule opens the selected model's
// levels — without the hover flyout, fast mode, image badge or Settings
// management. The named agent (ADR-0023) is part of the same pick (issue
// #254): a role is a model-level preset — model, thinking level and system
// prompt — so it lives in the model popover, one level down.
import { Fragment, useState, type ReactNode } from "react";
import { cn } from "cn";
import { Button } from "../../shared/ui/button.tsx";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from "../../shared/ui/item.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "../../shared/ui/popover.tsx";
import { Separator } from "../../shared/ui/separator.tsx";
import type { ModelRef } from "@earendil-works/pi-durable";
import type { AgentRole, AgentRoleProblem } from "@pinomad/protocol/agents.ts";
import type { ModelSummary, ThinkingLevel } from "@pinomad/protocol/view.ts";
import { sameModel, thinkingLevelLabels } from "@pinomad/client/model.ts";
import { Bot, Check, ChevronDown, ChevronLeft, ChevronRight } from "@/shared/ui/icons";
import { ModelLogo } from "./model-logo.tsx";

/**
 * The popover's Agent row: a draft or a 5.18 conversation picks one of the
 * host's roles (or none) from a list one level down; before 5.18 a
 * conversation shows the role it was created with, read-only (ADR-0023).
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
 * The composer's model and thinking capsules, side by side. The model
 * capsule reads `<logo> <model> from @agent` when the agent pins the model,
 * `with @agent` when it doesn't, and opens the Agent row plus the models
 * grouped by provider. The thinking capsule (only for a model that can
 * reason) reads `<meter> <level>` and opens just that model's levels. A side
 * the agent pins is shown but not pickable.
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
  /** Why the shown pick can't be sent — rendered in red instead of the label, with no Thinking capsule. */
  problem?: { readonly label: string; readonly title: string };
  onModelChange: (model: ModelRef) => void;
  onLevelChange: (level: ThinkingLevel) => void;
}) {
  const [modelOpen, setModelOpen] = useState(false);
  const [showAgents, setShowAgents] = useState(false);
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const selectedSummary = models.find((each) => sameModel(each, selected.model));
  const levels = selectedSummary?.thinkingLevels ?? ["off"];
  const agentName = agent === undefined ? undefined : agent.kind === "pick" ? agent.value : agent.name;
  const disabled = isDisabled || models.length === 0;
  const lockNote = agentName === undefined ? undefined : `Set by @${agentName}`;

  return (
    // Together no wider than the single capsule was; the model name truncates first.
    <span className="flex min-w-0 max-w-[19rem] items-center">
      <Popover
        open={modelOpen}
        onOpenChange={(open) => {
          setModelOpen(open);
          if (!open) setShowAgents(false);
        }}
      >
        <PopoverTrigger
          render={
            <Button
              className="min-w-0 shrink flex-nowrap gap-1.5 px-2 text-muted-foreground"
              data-testid="model-trigger"
              disabled={disabled}
              aria-label="Model"
              size="md"
              variant="ghost"
              {...(problem === undefined ? {} : { tooltip: problem.title })}
            />
          }
        >
          <span className="flex min-w-0 items-center gap-1.5">
            {problem === undefined && selected.model !== undefined ? <ModelLogo model={selected.model} size={14} /> : null}
            {problem === undefined ? (
              <span className="truncate">{selectedSummary?.name ?? selected.model?.modelId ?? "No model"}</span>
            ) : (
              <span className="truncate text-destructive">{problem.label}</span>
            )}
            {agentName === undefined ? null : (
              // Shrinks before the model name does.
              <span className="min-w-0 shrink-[4] truncate text-xs text-muted-foreground">
                {locked.model ? "from" : "with"} @{agentName}
              </span>
            )}
            {/* The Select trigger's glyph, so it matches the draft tray's pickers. */}
            <ChevronDown aria-hidden="true" strokeWidth={2} className="size-4" />
          </span>
        </PopoverTrigger>
        <PopoverContent aria-label="Model" side="top" align="start" className="w-[264px] p-1">
          <div
            className="flex w-full flex-col"
            data-testid="model-popover"
            // The popover is portal-mounted but React events still bubble to
            // the ChatComposer, whose click-to-focus would steal focus from
            // the popover. Keep pointer events inside it.
            onClick={stopPropagation}
            onMouseDown={stopPropagation}
            onPointerDown={stopPropagation}
          >
            {agent !== undefined && agent.kind === "pick" && showAgents ? (
              <AgentList
                agent={agent}
                models={models}
                isDisabled={isDisabled}
                onBack={() => setShowAgents(false)}
                onPicked={() => setShowAgents(false)}
              />
            ) : (
              <>
                {agent === undefined ? null : (
                  <>
                    <AgentRow agent={agent} name={agentName} onOpen={() => setShowAgents(true)} />
                    <Separator className="mx-2 my-1 w-auto" />
                  </>
                )}
                {locked.model && lockNote !== undefined ? <SectionLabel>{lockNote}</SectionLabel> : null}
                {groupByProvider(models).map((group, index) => (
                  <Fragment key={group.provider}>
                    {index === 0 ? null : <Separator className="mx-2 my-1 w-auto" />}
                    <div role="group" aria-label={group.provider}>
                      <SectionLabel>{group.provider}</SectionLabel>
                      <ItemGroup>
                        {group.models.map((model) => (
                          <PickRow
                            key={model.modelId}
                            media={<ModelLogo model={model} reserve />}
                            title={model.name}
                            selected={sameModel(model, selected.model)}
                            disabled={isDisabled || locked.model}
                            onPick={() => {
                              onModelChange({ provider: model.provider, modelId: model.modelId });
                              setModelOpen(false);
                            }}
                          />
                        ))}
                      </ItemGroup>
                    </div>
                  </Fragment>
                ))}
              </>
            )}
          </div>
        </PopoverContent>
      </Popover>
      {problem !== undefined || levels.length < 2 ? null : (
        <Popover open={thinkingOpen} onOpenChange={setThinkingOpen}>
          <PopoverTrigger
            render={
              <Button
                className="shrink-0 gap-1.5 px-2 text-muted-foreground"
                data-testid="thinking-trigger"
                disabled={disabled}
                aria-label={`Thinking: ${thinkingLevelLabels[selected.level]}`}
                size="md"
                variant="ghost"
              />
            }
          >
            <LevelMeter levels={levels} level={selected.level} />
            {thinkingLevelLabels[selected.level]}
          </PopoverTrigger>
          <PopoverContent aria-label="Thinking" side="top" align="start" className="w-[200px] p-1">
            <div
              role="group"
              aria-label="Thinking"
              onClick={stopPropagation}
              onMouseDown={stopPropagation}
              onPointerDown={stopPropagation}
            >
              <SectionLabel>{locked.level && lockNote !== undefined ? `Thinking · ${lockNote.toLowerCase()}` : "Thinking"}</SectionLabel>
              <ItemGroup>
                {[...levels].reverse().map((level) => (
                  <PickRow
                    key={level}
                    media={<LevelMeter levels={levels} level={level} className="text-muted-foreground" />}
                    title={thinkingLevelLabels[level]}
                    selected={level === selected.level}
                    disabled={isDisabled || locked.level}
                    onPick={() => {
                      onLevelChange(level);
                      setThinkingOpen(false);
                    }}
                  />
                ))}
              </ItemGroup>
            </div>
          </PopoverContent>
        </Popover>
      )}
    </span>
  );
}

const stopPropagation = (event: React.SyntheticEvent) => event.stopPropagation();

function groupByProvider(models: readonly ModelSummary[]): { provider: string; models: ModelSummary[] }[] {
  const groups = new Map<string, ModelSummary[]>();
  for (const model of models) groups.set(model.provider, [...(groups.get(model.provider) ?? []), model]);
  return [...groups].map(([provider, list]) => ({ provider, models: list }));
}

function SectionLabel({ children }: { children: ReactNode }) {
  return <p className="px-2 pt-1.5 pb-1 text-xs text-muted-foreground">{children}</p>;
}

/** The Agent row at the top of the model popover: the current agent, opening the list when it can change. */
function AgentRow({ agent, name, onOpen }: { agent: ModelSelectorAgent; name: string | undefined; onOpen: () => void }) {
  const missing = agent.kind === "pick" && name !== undefined && !agent.roles.some((role) => role.name === name);
  const description =
    agent.kind === "fixed" ? "Fixed at creation" : missing ? "No longer available" : name === undefined ? "Default system prompt" : undefined;
  const content = (
    <>
      <Bot aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{name === undefined ? "No agent" : `@${name}`}</span>
        {description === undefined ? null : (
          <span className={cn("block truncate text-xs", missing ? "text-destructive" : "text-muted-foreground")}>{description}</span>
        )}
      </span>
    </>
  );
  if (agent.kind === "fixed") {
    return (
      <div role="group" aria-label="Agent" className="flex items-center gap-2 px-2 py-1.5">
        {content}
      </div>
    );
  }
  return (
    <button
      type="button"
      aria-label={`Agent: ${name ?? "No agent"}`}
      onClick={onOpen}
      className={cn(
        "flex w-full cursor-pointer items-center gap-2 rounded-[var(--radius-element)] px-2 py-1.5 text-start outline-none transition-colors duration-100",
        "[@media(hover:hover)]:hover:bg-surface-hover active:bg-default focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
      )}
    >
      {content}
      <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
    </button>
  );
}

/**
 * The agent list, one level down: No agent, then each role with its
 * description and pinned model. A role whose pinned model the host doesn't
 * offer, and a role file the host couldn't read, are listed but not pickable.
 */
function AgentList({
  agent,
  models,
  isDisabled,
  onBack,
  onPicked,
}: {
  agent: Extract<ModelSelectorAgent, { kind: "pick" }>;
  models: readonly ModelSummary[];
  isDisabled: boolean;
  onBack: () => void;
  onPicked: () => void;
}) {
  const pick = (name: string | undefined) => {
    agent.onChange(name);
    onPicked();
  };
  const missing =
    agent.value !== undefined && !agent.roles.some((role) => role.name === agent.value) ? agent.value : undefined;
  return (
    <div role="group" aria-label="Agent">
      <button
        type="button"
        onClick={onBack}
        className="flex h-7 w-full cursor-pointer items-center gap-1 rounded-[var(--radius-element)] px-1.5 text-xs text-muted-foreground outline-none transition-colors [@media(hover:hover)]:hover:bg-surface-hover [@media(hover:hover)]:hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary"
      >
        <ChevronLeft aria-hidden="true" className="size-3.5" />
        Agent
      </button>
      <Separator className="mx-2 my-1 w-auto" />
      <ItemGroup className="max-h-80 overflow-y-auto">
        {missing === undefined ? null : (
          <PickRow
            media={<Bot aria-hidden="true" className="size-4" />}
            title={missing}
            description="No longer available"
            tone="destructive"
            selected
            disabled
          />
        )}
        <PickRow
          media={<Bot aria-hidden="true" className="size-4 text-muted-foreground" />}
          title="No agent"
          description="Default system prompt"
          selected={agent.value === undefined}
          disabled={isDisabled}
          onPick={() => pick(undefined)}
        />
        {agent.roles.map((role) => {
          const pinned = role.model === undefined ? undefined : models.find((model) => `${model.provider}/${model.modelId}` === role.model);
          const unavailable = role.model !== undefined && pinned === undefined;
          return (
            <PickRow
              key={role.name}
              media={pinned === undefined ? <Bot aria-hidden="true" className="size-4 text-muted-foreground" /> : <ModelLogo model={pinned} reserve />}
              title={role.name}
              description={unavailable ? `${role.model} isn't available` : pinnedLabel(pinned, role.thinkingLevel) ?? role.description}
              {...(unavailable ? { tone: "destructive" as const } : {})}
              hint={role.description}
              selected={agent.value === role.name}
              disabled={isDisabled || unavailable}
              onPick={() => pick(role.name)}
            />
          );
        })}
        {(agent.problems ?? []).map((broken) => (
          <PickRow
            key={broken.file}
            media={<Bot aria-hidden="true" className="size-4 text-muted-foreground" />}
            title={broken.file}
            description={broken.reason}
            tone="destructive"
            selected={false}
            disabled
          />
        ))}
      </ItemGroup>
    </div>
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

/**
 * One choice in a popover: a selected row is tinted, marked aria-current and
 * checked; a row without `onPick` is read-only and has no button.
 */
function PickRow({
  title,
  description,
  hint,
  tone,
  media,
  selected,
  disabled = false,
  onPick,
}: {
  title: string;
  description?: string | undefined;
  /** Tooltip for the whole row. */
  hint?: string;
  tone?: "destructive";
  media: ReactNode;
  selected: boolean;
  disabled?: boolean;
  onPick?: () => void;
}) {
  return (
    <Item size="sm" render={<li />} title={hint} aria-current={selected || undefined} aria-disabled={disabled || undefined}>
      <ItemMedia>{media}</ItemMedia>
      <ItemContent render={onPick === undefined ? undefined : <button type="button" disabled={disabled} onClick={onPick} />}>
        <ItemTitle>{title}</ItemTitle>
        {description === undefined ? null : (
          <ItemDescription className={cn("truncate", tone === "destructive" && "text-destructive")}>{description}</ItemDescription>
        )}
      </ItemContent>
      {selected ? (
        <ItemActions>
          <Check aria-hidden="true" className="size-4 shrink-0 text-foreground" />
        </ItemActions>
      ) : null}
    </Item>
  );
}
