// Simplified port of Pace's ModelSelectorControl
// (entities/model/model-selector/model-selector-control.tsx, PiGUI commit
// 15b9084): same capsule trigger and popover layout — a searchable model
// list and the selected model's thinking levels — without the hover flyout,
// fast mode, image badge or Settings management. The named agent (ADR-0023)
// is part of the same pick (issue #254): a role is a model-level preset —
// model, thinking level and system prompt — so it lives in this popover too.
import { useRef, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { List, ListItem } from "@astryxdesign/core/List";
import { Popover } from "@astryxdesign/core/Popover";
import { TextInput } from "@astryxdesign/core/TextInput";
import type { ModelRef } from "@earendil-works/pi-durable";
import type { AgentRole } from "@pinomad/protocol/agents.ts";
import type { ModelSummary, ThinkingLevel } from "@pinomad/protocol/view.ts";
import { filterModels, modelLabel, sameModel, thinkingLevelLabels } from "@pinomad/client/model.ts";
import { Check } from "@/shared/ui/icons";

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
 * The composer model/thinking capsule: a ghost button showing
 * `<model name> · <Thinking label>` (just the name when the model can't
 * reason), prefixed with `@name` when a named agent is set, opening a
 * popover with the Agent section, a searchable model list and the selected
 * model's thinking levels.
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
  /** Why the shown pick can't be sent — rendered in red instead of the label. */
  problem?: { readonly label: string; readonly title: string };
  onModelChange: (model: ModelRef) => void;
  onLevelChange: (level: ThinkingLevel) => void;
}) {
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const selectedSummary = models.find((each) => sameModel(each, selected.model));
  const levels = selectedSummary?.thinkingLevels ?? ["off"];
  const filtered = filterModels(models, query);
  const agentName = agent === undefined ? undefined : agent.kind === "pick" ? agent.value : agent.name;
  // A role file can be deleted or broken while a conversation still names it:
  // keep showing that name as the selected, unavailable row until the user
  // picks something else.
  const missingAgent =
    agent?.kind === "pick" && agent.value !== undefined && !agent.roles.some((role) => role.name === agent.value)
      ? agent.value
      : undefined;

  return (
    <Popover
      alignment="start"
      label="Model and Thinking"
      placement="above"
      width={236}
      // Opening lands in the search box, as before the Agent section took
      // the top: the popover's own autofocus would pick "No agent" instead.
      hasAutoFocus={false}
      onOpenChange={(open) => {
        if (open) requestAnimationFrame(() => searchRef.current?.focus());
      }}
      content={
        <div
          className="flex w-full flex-col gap-1 p-1"
          data-testid="model-thinking-popover"
          // The popover is portal-mounted but React events still bubble to
          // the ChatComposer, whose click-to-focus would steal focus from the
          // search input. Keep pointer events inside the popover.
          onClick={(event: React.MouseEvent) => event.stopPropagation()}
          onMouseDown={(event: React.MouseEvent) => event.stopPropagation()}
          onPointerDown={(event: React.PointerEvent) => event.stopPropagation()}
        >
          {agent === undefined ? null : (
            // Same visible heading + role="group" as the Thinking section.
            <div aria-label="Agent" role="group">
              <p className="px-2 pt-1 text-xs text-muted">
                {agent.kind === "pick" ? "Agent · sets the system prompt" : "Agent · fixed at creation"}
              </p>
              {agent.kind === "pick" ? (
                <List className="max-h-48 overflow-y-auto" density="compact">
                  {missingAgent === undefined ? null : (
                    <ListItem
                      description="No longer available"
                      endContent={<Check aria-hidden="true" className="size-4 shrink-0 text-foreground" />}
                      isDisabled
                      isSelected
                      label={missingAgent}
                    />
                  )}
                  <ListItem
                    description="Default system prompt"
                    endContent={
                      agent.value === undefined
                        ? <Check aria-hidden="true" className="size-4 shrink-0 text-foreground" />
                        : undefined
                    }
                    isDisabled={isDisabled}
                    isSelected={agent.value === undefined}
                    label="No agent"
                    onClick={() => agent.onChange(undefined)}
                  />
                  {agent.roles.map((role) => (
                    <ListItem
                      description={role.description}
                      endContent={
                        agent.value === role.name
                          ? <Check aria-hidden="true" className="size-4 shrink-0 text-foreground" />
                          : undefined
                      }
                      isDisabled={isDisabled}
                      isSelected={agent.value === role.name}
                      key={role.name}
                      label={role.name}
                      onClick={() => agent.onChange(role.name)}
                    />
                  ))}
                </List>
              ) : (
                <List density="compact">
                  <ListItem
                    {...(agent.description === undefined ? {} : { description: agent.description })}
                    endContent={<Check aria-hidden="true" className="size-4 shrink-0 text-foreground" />}
                    isSelected
                    label={agent.name}
                  />
                </List>
              )}
            </div>
          )}
          <TextInput
            isLabelHidden
            label="Search models"
            placeholder="Search models"
            ref={searchRef}
            size="sm"
            value={query}
            width="100%"
            onChange={(value: string) => setQuery(value)}
          />
          <List aria-label="Model" className="max-h-72 overflow-y-auto" density="compact">
            {filtered.map((model) => (
              <ListItem
                description={model.provider}
                endContent={
                  sameModel(model, selected.model)
                    ? <Check aria-hidden="true" className="size-4 shrink-0 text-foreground" />
                    : undefined
                }
                isDisabled={isDisabled}
                isSelected={sameModel(model, selected.model)}
                key={`${model.provider}/${model.modelId}`}
                label={model.name}
                onClick={() => onModelChange({ provider: model.provider, modelId: model.modelId })}
              />
            ))}
          </List>
          {levels.length > 1 ? (
            // Astryx List doesn't forward aria-label (0.3.0), so the section
            // gets a visible heading plus a role="group" wrapper.
            <div aria-label="Thinking" role="group">
              <p className="px-2 pt-1 text-xs text-muted">Thinking</p>
              <List density="compact">
                {levels.map((level) => (
                  <ListItem
                    endContent={
                      level === selected.level
                        ? <Check aria-hidden="true" className="size-4 shrink-0 text-foreground" />
                        : undefined
                    }
                    isDisabled={isDisabled}
                    key={level}
                    label={thinkingLevelLabels[level]}
                    onClick={() => onLevelChange(level)}
                  />
                ))}
              </List>
            </div>
          ) : null}
        </div>
      }
    >
      <Button
        className="min-w-0 max-w-[19rem] flex-nowrap gap-1.5 px-2 text-muted"
        data-testid="model-thinking-trigger"
        isDisabled={isDisabled || models.length === 0}
        label="Model and Thinking"
        size="sm"
        variant="ghost"
        {...(problem === undefined ? {} : { tooltip: problem.title })}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          {problem === undefined ? (
            <span className="truncate">
              {agentName === undefined ? "" : `@${agentName} · `}
              {modelLabel(models, selected)}
            </span>
          ) : (
            <span className="truncate text-danger">{problem.label}</span>
          )}
          {sourceHint === undefined || problem !== undefined ? null : (
            <span className="shrink-0 truncate text-xs text-muted">{sourceHint}</span>
          )}
          {/* Astryx's own glyph, so it matches the draft tray's Selector chevrons. */}
          <Icon icon="chevronDown" size="sm" color="inherit" />
        </span>
      </Button>
    </Popover>
  );
}
