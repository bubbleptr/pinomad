// The model · thinking picker: a ghost capsule in the composer's actions row
// that opens a bottom sheet — searchable model list plus the selected model's
// thinking levels, mirroring the web's ModelSelector popover.
import { useState } from "react";
import { Keyboard, Pressable, StyleSheet, Text, View } from "react-native";
import { BottomSheet, SearchField, useBottomSheetAwareHandlers } from "heroui-native";
import { BottomSheetScrollView } from "@gorhom/bottom-sheet";
import type { ModelRef } from "@earendil-works/pi-durable";
import type { ModelSummary, ThinkingLevel } from "@pinomad/protocol/view.ts";
import { clampLevel, filterModels, modelLabel, sameModel, summaryOf, thinkingLevelLabels } from "@pinomad/client/model.ts";
import { useCSSVariable } from "uniwind";
import { Check, ChevronDown } from "../../shared/ui/icons.tsx";

const ROW_HEIGHT = 44;

/** Search input that keeps the sheet clear of the keyboard (see hero-ui bottom-sheet docs). */
function SheetSearchField({ query, onChange }: { query: string; onChange(next: string): void }) {
  const { onFocus, onBlur } = useBottomSheetAwareHandlers();
  return (
    <View style={styles.searchWrap}>
      <SearchField value={query} onChange={onChange}>
        <SearchField.Group>
          <SearchField.SearchIcon />
          <SearchField.Input placeholder="Search models" onFocus={onFocus} onBlur={onBlur} />
          <SearchField.ClearButton />
        </SearchField.Group>
      </SearchField>
    </View>
  );
}

function ModelRow({
  model,
  selected,
  onPress,
}: {
  model: ModelSummary;
  selected: boolean;
  onPress(): void;
}) {
  const [foreground, muted] = useCSSVariable(["--foreground", "--muted"]) as Array<string | undefined>;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
    >
      <View style={styles.rowText}>
        <Text className="text-foreground" style={{ fontSize: 15 }} numberOfLines={1}>
          {model.name}
        </Text>
        <Text className="text-muted" style={{ fontSize: 12 }} numberOfLines={1}>
          {model.provider}
        </Text>
      </View>
      {selected ? <Check size={16} color={foreground} /> : null}
    </Pressable>
  );
}

export function ModelSheet({
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
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  // The last model picked while the sheet stayed open for a level pick — the
  // host echoes the change async, so until then the Thinking section and the
  // model checkmark show the pick, not the stale `selected.model`.
  const [pendingModel, setPendingModel] = useState<ModelRef | undefined>();
  const [foreground, muted, border] = useCSSVariable(["--foreground", "--muted", "--border"]) as Array<
    string | undefined
  >;
  const shownModel = pendingModel ?? selected.model;
  const selectedSummary = summaryOf(models, shownModel);
  const levels = selectedSummary?.thinkingLevels ?? ["off"];
  const filtered = filterModels(models, query);
  const disabled = isDisabled || models.length === 0;

  const pickModel = (model: ModelSummary): void => {
    const ref: ModelRef = { provider: model.provider, modelId: model.modelId };
    onModelChange(ref);
    setPendingModel(ref);
    // A multi-level model invites a follow-up level pick; keep the sheet open.
    if (model.thinkingLevels.length <= 1) setOpen(false);
  };
  const pickLevel = (level: ThinkingLevel): void => {
    onLevelChange(level);
    setPendingModel(undefined);
    setOpen(false);
  };

  return (
    <BottomSheet
      isOpen={open}
      onOpenChange={(next) => {
        // The composer is usually focused when this opens; the sheet must not
        // fight the keyboard for the space it slides into.
        if (next) Keyboard.dismiss();
        else setPendingModel(undefined);
        setOpen(next);
      }}
    >
      <BottomSheet.Trigger asChild>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Model and thinking"
          disabled={disabled}
          hitSlop={8}
          style={[styles.trigger, disabled ? styles.triggerDisabled : null]}
        >
          <Text className="text-muted" style={styles.triggerLabel} numberOfLines={1}>
            {modelLabel(models, selected)}
          </Text>
          <ChevronDown size={14} color={muted} />
        </Pressable>
      </BottomSheet.Trigger>
      <BottomSheet.Portal>
        <BottomSheet.Overlay />
        <BottomSheet.Content
          snapPoints={["62%"]}
          enableDynamicSizing={false}
          enableOverDrag={false}
          keyboardBehavior="extend"
          contentContainerClassName="h-full"
        >
          <SheetSearchField query={query} onChange={setQuery} />
          <BottomSheetScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={styles.listContent}
          >
            {filtered.map((model) => (
              <ModelRow
                key={`${model.provider}/${model.modelId}`}
                model={model}
                selected={sameModel(model, shownModel)}
                onPress={() => pickModel(model)}
              />
            ))}
          </BottomSheetScrollView>
          {levels.length > 1 ? (
            <View style={[styles.levels, { borderTopColor: border }]}>
              <Text className="text-muted" style={styles.levelsTitle}>
                Thinking
              </Text>
              {levels.map((level) => (
                <Pressable
                  key={level}
                  accessibilityRole="button"
                  onPress={() => pickLevel(level)}
                  style={({ pressed }) => [styles.levelRow, pressed && { opacity: 0.6 }]}
                >
                  <Text className="text-foreground" style={{ fontSize: 15 }}>
                    {thinkingLevelLabels[level]}
                  </Text>
                  {level === clampLevel(levels, selected.level) ? <Check size={16} color={foreground} /> : null}
                </Pressable>
              ))}
            </View>
          ) : null}
        </BottomSheet.Content>
      </BottomSheet.Portal>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  trigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    flexShrink: 1,
    minWidth: 0,
    maxWidth: 240,
    paddingVertical: 8,
    paddingHorizontal: 4,
  },
  triggerDisabled: {
    opacity: 0.4,
  },
  triggerLabel: {
    fontSize: 15,
    flexShrink: 1,
  },
  searchWrap: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 4,
  },
  listContent: {
    paddingHorizontal: 8,
    paddingBottom: 8,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: ROW_HEIGHT,
    paddingHorizontal: 8,
    gap: 8,
  },
  rowText: {
    flex: 1,
    minWidth: 0,
    gap: 1,
  },
  levels: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 4,
    paddingBottom: 8,
    paddingHorizontal: 16,
  },
  levelsTitle: {
    fontSize: 13,
    paddingVertical: 4,
  },
  levelRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    minHeight: 36,
  },
});
