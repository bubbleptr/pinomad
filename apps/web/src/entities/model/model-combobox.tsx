import type { ModelRef } from "@earendil-works/pi-durable";
import type { ModelSummary } from "@pinomad/protocol/view.ts";
import { sameModel } from "@pinomad/client/model.ts";
import {
  Combobox,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
  ComboboxTrigger,
  ComboboxValue,
} from "../../shared/ui/combobox.tsx";
import { selectTriggerClassName } from "../../shared/ui/select.tsx";
import { ModelLogo } from "./model-logo.tsx";

/**
 * A settings row's model picker: the host's models grouped by provider, with
 * search. `null` shows the placeholder, for a setting that inherits.
 */
export function ModelCombobox({
  label,
  models,
  value,
  placeholder,
  disabled,
  onChange,
}: {
  label: string;
  models: readonly ModelSummary[];
  value: ModelRef | null;
  placeholder: string;
  disabled: boolean;
  onChange: (picked: ModelRef) => void;
}) {
  const model = value === null ? undefined : models.find((each) => sameModel(each, value));
  const groups = [...new Set(models.map((each) => each.provider))].map((provider) => ({
    provider,
    items: models.filter((each) => each.provider === provider),
  }));
  return (
    <Combobox
      items={groups}
      value={model ?? null}
      itemToStringLabel={(each: ModelSummary) => each.name}
      isItemEqualToValue={(a: ModelSummary, b: ModelSummary) => sameModel(a, b)}
      disabled={disabled || models.length === 0}
      onValueChange={(picked: ModelSummary | null) => {
        if (picked !== null) onChange({ provider: picked.provider, modelId: picked.modelId });
      }}
    >
      <ComboboxTrigger aria-label={label} data-size="sm" data-variant="outline" className={selectTriggerClassName}>
        {model === undefined ? null : <ModelLogo model={model} size={14} />}
        <ComboboxValue placeholder={placeholder} />
      </ComboboxTrigger>
      <ComboboxContent className="min-w-64">
        <ComboboxInput aria-label="Search models" placeholder="Search models" showTrigger={false} />
        <ComboboxEmpty>No models match</ComboboxEmpty>
        <ComboboxList>
          {(group: { provider: string; items: ModelSummary[] }) => (
            <ComboboxGroup key={group.provider} items={group.items}>
              <ComboboxLabel>{group.provider}</ComboboxLabel>
              <ComboboxCollection>
                {(each: ModelSummary) => (
                  <ComboboxItem key={`${each.provider}/${each.modelId}`} value={each}>
                    <ModelLogo model={each} size={14} reserve />
                    {each.name}
                  </ComboboxItem>
                )}
              </ComboboxCollection>
            </ComboboxGroup>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
