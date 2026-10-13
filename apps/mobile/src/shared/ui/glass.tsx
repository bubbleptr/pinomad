// One home for Liquid Glass availability + backdrop: the native module is
// always linked, but the effect only exists on iOS 26+ — the API check
// guards the crash risk expo added it for, and the component check answers
// whether this build actually renders the material. Both are cached.
import { Platform, StyleSheet } from "react-native";
import { GlassView, isGlassEffectAPIAvailable, isLiquidGlassAvailable } from "expo-glass-effect";

let cached: boolean | undefined;

export const liquidGlass = (): boolean =>
  (cached ??= Platform.OS === "ios" && isGlassEffectAPIAvailable() && isLiquidGlassAvailable());

/** A glass material layer for floating chrome; the caller drops bg/border/shadow on this path. */
export function GlassBackdrop({ radius }: { radius: number }) {
  return (
    <GlassView
      style={[StyleSheet.absoluteFill, { borderRadius: radius, pointerEvents: "none" }]}
      glassEffectStyle="regular"
    />
  );
}
