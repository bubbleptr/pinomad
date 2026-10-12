// Where the conversation runs: the location row inside the composer's footer.
// Chips mirror the web's ComposerStaticChip — a selector-styled location chip
// and a muted branch chip — plus a pressable form for the draft's pickers.
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { ComponentType, Ref } from "react";
import { useCSSVariable } from "uniwind";
import { ChevronDown } from "../../shared/ui/icons.tsx";

type ChipIcon = ComponentType<{ size?: number; color?: string }>;

export function LocationChip({
  icon: Icon,
  label,
  muted = false,
  onPress,
  testID,
  ref,
}: {
  icon: ChipIcon;
  label: string;
  /** Branch-style chip: dimmer label than the selector chrome. */
  muted?: boolean;
  /** Given, the chip is a tappable picker showing a trailing chevron. */
  onPress?(): void;
  testID?: string;
  /** Menu.Trigger asChild measures the chip to anchor its popover. */
  ref?: Ref<View>;
}) {
  const mutedColor = useCSSVariable("--muted") as string | undefined;
  const content = (
    <>
      <Icon size={14} color={mutedColor} />
      <Text className={muted ? "text-muted" : "text-foreground"} style={styles.label} numberOfLines={1}>
        {label}
      </Text>
      {onPress === undefined ? null : <ChevronDown size={14} color={mutedColor} />}
    </>
  );
  if (onPress === undefined) {
    return (
      <View ref={ref} style={styles.chip} testID={testID}>
        {content}
      </View>
    );
  }
  return (
    <Pressable
      ref={ref}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={8}
      onPress={onPress}
      style={({ pressed }) => [styles.chip, pressed && { opacity: 0.6 }]}
      testID={testID}
    >
      {content}
    </Pressable>
  );
}

/** Left-aligned single-line row of location/branch chips. */
export function LocationRow({ children }: { children: React.ReactNode }) {
  return <View style={styles.row}>{children}</View>;
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    minHeight: 20,
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    flexShrink: 1,
    minWidth: 0,
    maxWidth: 220,
  },
  label: {
    fontSize: 13,
    flexShrink: 1,
  },
});
