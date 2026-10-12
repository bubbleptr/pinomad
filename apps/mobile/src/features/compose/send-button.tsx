// The composer's right-hand slot: empty while the draft is, a send circle
// once there's text, a stop circle while a run is busy with an empty draft.
// Holding send during a run opens the steer/follow-up wheel — the pan owns
// the touch for the whole drag, so the bubbles never need hit areas.
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { Easing, useSharedValue, ZoomIn, ZoomOut } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import * as Haptics from "expo-haptics";
import { useCSSVariable, useUniwind } from "uniwind";
import { ArrowUp, FollowUp, Steer, Stop } from "../../shared/ui/icons.tsx";
import { WHEEL_OPTIONS, wheelHit, type WheelOption } from "./wheel-hit.ts";

const BUTTON = 36;
const BUBBLE = 56;

// Short ease-out pops so the slot never feels laggy; Reanimated's default
// ReduceMotion.System honors the reduced-motion setting.
const popIn = ZoomIn.duration(150).easing(Easing.out(Easing.quad));
const popOut = ZoomOut.duration(120).easing(Easing.out(Easing.quad));

const WHEEL_ICONS = { followUp: FollowUp, steer: Steer } as const;

interface WheelColors {
  surface?: string;
  border?: string;
  foreground?: string;
  background?: string;
  muted?: string;
}

function WheelBubble({
  option,
  hovered,
  colors,
  dark,
}: {
  option: WheelOption;
  hovered: boolean;
  colors: WheelColors;
  dark: boolean;
}) {
  const Icon = WHEEL_ICONS[option.mode];
  return (
    <Animated.View
      entering={popIn}
      exiting={popOut}
      pointerEvents="none"
      style={[
        styles.bubbleWrap,
        { left: BUTTON / 2 + option.dx - BUBBLE / 2, top: BUTTON / 2 + option.dy - BUBBLE / 2 },
        hovered ? { transform: [{ scale: 1.12 }] } : null,
      ]}
    >
      <View
        style={[
          styles.bubble,
          { backgroundColor: hovered ? colors.foreground : colors.surface, borderColor: colors.border },
          dark ? null : styles.liftShadow,
        ]}
      >
        <Icon size={22} color={hovered ? colors.background : colors.foreground} />
      </View>
      <Text style={[styles.bubbleLabel, { color: hovered ? colors.foreground : colors.muted }]}>{option.label}</Text>
    </Animated.View>
  );
}

export function SendSlot({
  hasText,
  busy,
  disabled,
  onSend,
  onStop,
}: {
  hasText: boolean;
  busy: boolean;
  disabled: boolean;
  onSend(mode: "steer" | "followUp"): void;
  onStop?(): void;
}) {
  const [surface, border, foreground, background, muted] = useCSSVariable([
    "--surface",
    "--border",
    "--foreground",
    "--background",
    "--muted",
  ]) as Array<string | undefined>;
  const colors: WheelColors = { surface, border, foreground, background, muted };
  const dark = useUniwind().theme === "dark";
  const [wheelOpen, setWheelOpen] = useState(false);
  const [hovered, setHovered] = useState(-1);
  // Worklet-side copy of the hover index so updates only cross to JS on change.
  const lastHover = useSharedValue(-1);

  const openWheel = (): void => {
    setWheelOpen(true);
    setHovered(-1);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  };
  const closeWheel = (): void => {
    setWheelOpen(false);
    setHovered(-1);
  };
  const finishWheel = (index: number): void => {
    if (index >= 0) {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      onSend(WHEEL_OPTIONS[index].mode);
    }
    closeWheel();
  };
  const pickHaptic = (): void => {
    void Haptics.selectionAsync();
  };
  const tapSend = (): void => {
    if (hasText) onSend("followUp");
  };

  const pan = Gesture.Pan()
    .activateAfterLongPress(300)
    .enabled(busy && !disabled)
    .onStart(() => {
      "worklet";
      lastHover.value = -1;
      scheduleOnRN(openWheel);
    })
    .onUpdate((e) => {
      "worklet";
      const index = wheelHit(e.x - BUTTON / 2, e.y - BUTTON / 2);
      if (index === lastHover.value) return;
      lastHover.value = index;
      scheduleOnRN(setHovered, index);
      if (index >= 0) scheduleOnRN(pickHaptic);
    })
    .onEnd((e) => {
      "worklet";
      scheduleOnRN(finishWheel, wheelHit(e.x - BUTTON / 2, e.y - BUTTON / 2));
    })
    // Also runs after onEnd; closing is idempotent so a cancelled drag is safe.
    .onFinalize(() => {
      "worklet";
      scheduleOnRN(closeWheel);
    });
  const tap = Gesture.Tap()
    .enabled(!disabled)
    .onEnd(() => {
      "worklet";
      scheduleOnRN(tapSend);
    });

  if (!hasText) {
    if (!busy || onStop === undefined) return null;
    return (
      <Animated.View entering={popIn} exiting={popOut}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Stop"
          disabled={disabled}
          hitSlop={4}
          onPress={onStop}
          style={[styles.circle, { backgroundColor: foreground }, disabled ? styles.dimmed : null]}
        >
          <Stop size={15} color={background} />
        </Pressable>
      </Animated.View>
    );
  }

  return (
    <View style={styles.slot}>
      {wheelOpen
        ? WHEEL_OPTIONS.map((option, index) => (
            <WheelBubble key={option.mode} option={option} hovered={hovered === index} colors={colors} dark={dark} />
          ))
        : null}
      <GestureDetector gesture={Gesture.Exclusive(pan, tap)}>
        <Animated.View
          entering={popIn}
          exiting={popOut}
          accessible
          accessibilityRole="button"
          accessibilityLabel="Send"
          accessibilityHint={busy ? "Sends as a follow-up" : undefined}
          accessibilityActions={
            busy ? [{ name: "activate" }, { name: "steer", label: "Send as steer" }] : [{ name: "activate" }]
          }
          onAccessibilityAction={(e) => onSend(e.nativeEvent.actionName === "steer" ? "steer" : "followUp")}
          style={[styles.circle, { backgroundColor: foreground }, disabled ? styles.dimmed : null]}
        >
          <ArrowUp size={20} color={background} />
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create({
  slot: {
    width: BUTTON,
    height: BUTTON,
  },
  circle: {
    width: BUTTON,
    height: BUTTON,
    borderRadius: BUTTON / 2,
    alignItems: "center",
    justifyContent: "center",
  },
  dimmed: {
    opacity: 0.4,
  },
  bubbleWrap: {
    position: "absolute",
    width: BUBBLE,
    alignItems: "center",
    zIndex: 10,
  },
  bubble: {
    width: BUBBLE,
    height: BUBBLE,
    borderRadius: BUBBLE / 2,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
  liftShadow: {
    shadowColor: "#000",
    shadowOpacity: 0.08,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 4 },
  },
  bubbleLabel: {
    marginTop: 3,
    fontSize: 11,
    textAlign: "center",
  },
});
