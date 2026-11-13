// Simplified port of Pace's ModelSelectorControl
// (entities/model/model-selector/model-selector-control.tsx, PiGUI commit
// 15b9084), split in two: the model capsule opens the models grouped by
// provider, and a thinking capsule opens the selected model's levels —
// without the hover flyout, fast mode, image badge or Settings management. The named agent (ADR-0023)
// is part of the same pick (issue #254): a role is a model-level preset —
// model, thinking level and system prompt — so it lives in this popover too.
import { Fragment, useState, type ReactNode } from "react";
import { cn } from "cn";
import { Button } from "../../shared/ui/button.tsx";
import { Item, ItemActions, ItemContent, ItemGroup, ItemMedia, ItemTitle } from "../../shared/ui/item.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "../../shared/ui/popover.tsx";
import { Separator } from "../../shared/ui/separator.tsx";
import type { ModelRef } from "@earendil-works/pi-durable";
import type { AgentRole } from "@pinomad/protocol/agents.ts";
import type { ModelSummary, ThinkingLevel } from "@pinomad/protocol/view.ts";
import { sameModel, thinkingLevelLabels } from "@pinomad/client/model.ts";
import { Check, ChevronDown } from "@/shared/ui/icons";
import { ModelLogo } from "./model-logo.tsx";

/**
 * The popover's Agent section: a draft or a 5.18 conversation picks one of
 * the host's roles (or none); before 5.18 a conversation shows the role it
 * was created with, read-only (ADR-0023).
 */
export type ModelSelectorAgent =
  | {
      readonly kind: "pick";
      readonly roles: readonly AgentRole[];
      /** The picked role's name, undefined for "No agent". */
      readonly value?: string;
      readonly onChange: (agent: string | undefined) => void;
    }
  | { readonly kind: "fixed"; readonly name: string; readonly description?: string };

/**
 * The composer's model and thinking capsules, side by side: a ghost button
 * `<model logo> <model name>` (prefixed with `@name` when a named agent is
 * set) opening the Agent section and the models grouped by provider, and —
 * when the model can reason — a second ghost button `<meter> <level>` opening
 * just the selected model's thinking levels. Each popover answers one
 * question, so neither grows with the other's list.
 */
export function ModelSelector({
  models,
  selected,
  isDisabled = false,
  agent,
  sourceHint,
  problem,
  onModelChange,
  onLevelChange,
}: {
  models: readonly ModelSummary[];
  selected: { model?: ModelRef; level: ThinkingLevel };
  isDisabled?: boolean;
  /** Undefined hides the Agent section (nothing to show: no pick, and no fixed creation agent). */
  agent?: ModelSelectorAgent;
  /** Small muted suffix, e.g. which side of the pick is inherited from a named agent. */
  sourceHint?: string;
  /** Why the shown pick can't be sent — rendered in red instead of the label, with no Thinking capsule. */
  problem?: { readonly label: string; readonly title: string };
  onModelChange: (model: ModelRef) => void;
  onLevelChange: (level: ThinkingLevel) => void;
}) {
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const selectedSummary = models.find((each) => sameModel(each, selected.model));
  const levels = selectedSummary?.thinkingLevels ?? ["off"];
  const agentName = agent === undefined ? undefined : agent.kind === "pick" ? agent.value : agent.name;
  const disabled = isDisabled || models.length === 0;

  return (
    // Together no wider than the single capsule was; the model name truncates first.
    <span className="flex min-w-0 max-w-[19rem] items-center">
      <Popover>
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
              <span className="truncate">
                {agentName === undefined ? "" : `@${agentName} · `}
                {selectedSummary?.name ?? selected.model?.modelId ?? "No model"}
              </span>
            ) : (
              <span className="truncate text-destructive">{problem.label}</span>
            )}
            {sourceHint === undefined || problem !== undefined ? null : (
              <span className="shrink-0 truncate text-xs text-muted-foreground">{sourceHint}</span>
            )}
            {/* The Select trigger's glyph, so it matches the draft tray's pickers. */}
            <ChevronDown aria-hidden="true" strokeWidth={2} className="size-4" />
          </span>
        </PopoverTrigger>
        <PopoverContent aria-label="Model" side="top" align="start" className="w-[248px] p-1">
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
            {agent === undefined ? null : (
              <>
                <AgentSection agent={agent} isDisabled={isDisabled} />
                <Separator className="mx-2 my-1 w-auto" />
              </>
            )}
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
                        disabled={isDisabled}
                        onPick={() => onModelChange({ provider: model.provider, modelId: model.modelId })}
                      />
                    ))}
                  </ItemGroup>
                </div>
              </Fragment>
            ))}
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
              <SectionLabel>Thinking</SectionLabel>
              <ItemGroup>
                {[...levels].reverse().map((level) => (
                  <PickRow
                    key={level}
                    media={<LevelMeter levels={levels} level={level} className="text-muted-foreground" />}
                    title={thinkingLevelLabels[level]}
                    selected={level === selected.level}
                    disabled={isDisabled}
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

/**
 * The Agent section as a strip of chips, one line for a few roles. A role's
 * description is its tooltip; a role the host no longer lists stays as the
 * selected, unavailable chip until something else is picked.
 */
function AgentSection({ agent, isDisabled }: { agent: ModelSelectorAgent; isDisabled: boolean }) {
  const missing =
    agent.kind === "pick" && agent.value !== undefined && !agent.roles.some((role) => role.name === agent.value)
      ? agent.value
      : undefined;
  return (
    <div aria-label="Agent" role="group">
      <SectionLabel>{agent.kind === "pick" ? "Agent · sets the system prompt" : "Agent · fixed at creation"}</SectionLabel>
      <ul className="flex flex-wrap gap-1 px-2 pb-1">
        {agent.kind === "fixed" ? (
          <AgentChip name={agent.name} description={agent.description} selected />
        ) : (
          <>
            {missing === undefined ? null : <AgentChip name={missing} description="No longer available" selected unavailable />}
            <AgentChip
              label="No agent"
              description="Default system prompt"
              selected={agent.value === undefined}
              disabled={isDisabled}
              onPick={() => agent.onChange(undefined)}
            />
            {agent.roles.map((role) => (
              <AgentChip
                key={role.name}
                name={role.name}
                description={role.description}
                selected={agent.value === role.name}
                disabled={isDisabled}
                onPick={() => agent.onChange(role.name)}
              />
            ))}
          </>
        )}
      </ul>
    </div>
  );
}

const chipClassName = cn(
  "flex h-6 items-center rounded-full px-2.5 text-xs whitespace-nowrap text-muted-foreground shadow-[inset_0_0_0_1px_var(--border)] transition-colors",
  "group-aria-[current=true]/chip:bg-foreground group-aria-[current=true]/chip:text-background group-aria-[current=true]/chip:shadow-none",
);

/** One agent chip: `@name` (the `@` is decoration), or a plain label for "No agent". Without `onPick` it is read-only. */
function AgentChip({
  name,
  label,
  description,
  selected,
  unavailable = false,
  disabled = false,
  onPick,
}: {
  name?: string;
  label?: string;
  description?: string | undefined;
  selected: boolean;
  unavailable?: boolean;
  disabled?: boolean;
  onPick?: () => void;
}) {
  const content = (
    <>
      {name === undefined ? label : (
        <>
          <span aria-hidden="true" className="opacity-60">@</span>
          <span className={unavailable ? "line-through" : undefined}>{name}</span>
        </>
      )}
      {unavailable ? <span className="sr-only">No longer available</span> : null}
    </>
  );
  return (
    <li
      className="group/chip"
      title={description}
      aria-current={selected || undefined}
      aria-disabled={unavailable || disabled || undefined}
    >
      {onPick === undefined ? (
        <span className={cn(chipClassName, unavailable && "opacity-60")}>{content}</span>
      ) : (
        <button
          type="button"
          disabled={disabled}
          onClick={onPick}
          className={cn(
            chipClassName,
            "cursor-pointer outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50",
            // The picked chip keeps its inverted text on hover.
            !selected && "[@media(hover:hover)]:not-disabled:hover:text-foreground",
          )}
        >
          {content}
        </button>
      )}
    </li>
  );
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

/** One choice in a popover: a selected row is tinted, marked aria-current and checked. */
function PickRow({
  title,
  media,
  selected,
  disabled,
  onPick,
}: {
  title: string;
  media: ReactNode;
  selected: boolean;
  disabled: boolean;
  onPick: () => void;
}) {
  return (
    <Item size="sm" render={<li />} aria-current={selected || undefined} aria-disabled={disabled || undefined}>
      <ItemMedia>{media}</ItemMedia>
      <ItemContent render={<button type="button" disabled={disabled} onClick={onPick} />}>
        <ItemTitle>{title}</ItemTitle>
      </ItemContent>
      {selected ? (
        <ItemActions>
          <Check aria-hidden="true" className="size-4 shrink-0 text-foreground" />
        </ItemActions>
      ) : null}
    </Item>
  );
}
