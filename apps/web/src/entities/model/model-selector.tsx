// Simplified port of Pace's ModelSelectorControl
// (entities/model/model-selector/model-selector-control.tsx, PiGUI commit
// 15b9084): same capsule trigger and popover layout — a searchable model
// list and the selected model's thinking levels — without the hover flyout,
// fast mode, image badge or Settings management.
import { useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { List, ListItem } from "@astryxdesign/core/List";
import { Popover } from "@astryxdesign/core/Popover";
import { TextInput } from "@astryxdesign/core/TextInput";
import type { ModelRef } from "@earendil-works/pi-durable";
import type { ModelSummary, ThinkingLevel } from "@pinomad/protocol/view.ts";
import { Check, ChevronDown } from "@/shared/ui/icons";

export const thinkingLevelLabels: Record<ThinkingLevel, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "X-High",
  max: "Max",
};

const sameModel = (a: ModelRef | undefined, b: ModelRef | undefined): boolean =>
  a !== undefined && b !== undefined && a.provider === b.provider && a.modelId === b.modelId;

/**
 * The composer model/thinking capsule: a ghost button showing
 * `<model name> · <Thinking label>` (just the name when the model can't
 * reason) opening a popover with a searchable model list and the selected
 * model's thinking levels.
 */
export function ModelSelector({
  models,
  selected,
  isDisabled = false,
  onModelChange,
  onLevelChange,
}: {
  models: readonly ModelSummary[];
  selected: { model?: ModelRef; level: ThinkingLevel };
  isDisabled?: boolean;
  onModelChange: (model: ModelRef) => void;
  onLevelChange: (level: ThinkingLevel) => void;
}) {
  const [query, setQuery] = useState("");
  const selectedSummary = models.find((each) => sameModel(each, selected.model));
  const levels = selectedSummary?.thinkingLevels ?? ["off"];
  const needle = query.trim().toLowerCase();
  const filtered =
    needle === ""
      ? models
      : models.filter(
          (model) =>
            model.name.toLowerCase().includes(needle) || `${model.provider}/${model.modelId}`.toLowerCase().includes(needle),
        );

  return (
    <Popover
      alignment="start"
      label="Model and Thinking"
      placement="above"
      width={236}
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
          <TextInput
            isLabelHidden
            label="Search models"
            placeholder="Search models"
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
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate">
            {(() => {
              const name = selectedSummary?.name ?? selected.model?.modelId ?? "No model";
              return levels.length > 1 ? `${name} · ${thinkingLevelLabels[selected.level]}` : name;
            })()}
          </span>
          <ChevronDown aria-hidden="true" className="size-4 shrink-0" />
        </span>
      </Button>
    </Popover>
  );
}
