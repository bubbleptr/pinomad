// The composer's right-hand slot: empty while the draft is, a send circle
// once there's text, a stop circle while a run is busy with an empty draft.
// Holding send during a run opens the steer/follow-up fan — a quarter ring
// of wedges arcing up-left out of the button — and the pan owns the touch
// for the whole drag, so the wedges never need hit areas.
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  Easing,
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  ZoomIn,
  ZoomOut,
} from "react-native-reanimated";
import Svg, { G, Path } from "react-native-svg";
import { scheduleOnRN } from "react-native-worklets";
import * as Haptics from "expo-haptics";
import { useCSSVariable, useUniwind } from "uniwind";
import { ArrowUp, Cancel, FollowUp, Steer, Stop } from "../../shared/ui/icons.tsx";
import { FAN_OUTER, segmentAnchor, segmentPath, WHEEL_OPTIONS, wheelHit } from "./wheel-hit.ts";

const BUTTON = 36;
// The fan renders centered on the send button; 16pt of breathing room past
// the outer radius keeps the label and shadow inside the view.
const FAN_SIZE = (FAN_OUTER + 16) * 2;
const FAN_CENTER = FAN_SIZE / 2;
const AnimatedG = Animated.createAnimatedComponent(G);

// Short ease-out pops so the slot never feels laggy; Reanimated's default
// ReduceMotion.System honors the reduced-motion setting.
const popIn = ZoomIn.duration(150).easing(Easing.out(Easing.quad));
const popOut = ZoomOut.duration(120).easing(Easing.out(Easing.quad));
const HOVER_OUT = 5;

const WHEEL_ICONS = { followUp: FollowUp, steer: Steer } as const;

interface WheelColors {
  surface?: string;
  surfaceSecondary?: string;
  foreground?: string;
  background?: string;
  muted?: string;
}

interface FanSegmentProps {
  index: number;
  hovered: boolean;
  colors: WheelColors;
  dark: boolean;
}

/** Hover offset: ~5pt outward along the segment's mid-angle. */
function useHoverShift(index: number, hovered: boolean) {
  const progress = useSharedValue(0);
  const anchor = segmentAnchor(index);
  const length = Math.hypot(anchor.dx, anchor.dy);
  const tx = (anchor.dx / length) * HOVER_OUT;
  const ty = (anchor.dy / length) * HOVER_OUT;
  useEffect(() => {
    progress.value = withTiming(hovered ? 1 : 0, { duration: 120, easing: Easing.out(Easing.quad) });
  }, [hovered, progress]);
  return { progress, anchor, tx, ty };
}

function FanWedge({ index, hovered, colors, dark }: FanSegmentProps) {
  const { progress, tx, ty } = useHoverShift(index, hovered);
  const pathProps = useAnimatedProps(() => ({
    transform: `translate(${tx * progress.value} ${ty * progress.value})`,
  }));
  const d = segmentPath(index);
  // Dark mode lifts the wedge one surface level so it reads on the dark
  // background; a border stroke would inset inside the rounded silhouette.
  const fill = hovered ? colors.foreground : dark ? colors.surfaceSecondary : colors.surface;
  return (
    <AnimatedG animatedProps={pathProps}>
      {/* Same-color 10pt round-join stroke rounds the wedge corners. */}
      <Path d={d} fill={fill} stroke={fill} strokeWidth={10} strokeLinejoin="round" />
    </AnimatedG>
  );
}

function FanLabel({ index, hovered, colors }: FanSegmentProps) {
  const { progress, anchor, tx, ty } = useHoverShift(index, hovered);
  const labelStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: tx * progress.value }, { translateY: ty * progress.value }],
  }));
  const option = WHEEL_OPTIONS[index];
  const Icon = WHEEL_ICONS[option.mode];
  return (
    <Animated.View
      style={[styles.fanLabel, { pointerEvents: "none" }, { left: FAN_CENTER + anchor.dx - 28, top: FAN_CENTER + anchor.dy - 19 }, labelStyle]}
    >
      <Icon size={22} color={hovered ? colors.background : colors.foreground} />
      <Text style={[styles.fanLabelText, { color: hovered ? colors.background : colors.muted }]}>{option.label}</Text>
    </Animated.View>
  );
}

function Fan({ hovered, colors, dark }: { hovered: number; colors: WheelColors; dark: boolean }) {
  return (
    <Animated.View
      entering={ZoomIn.duration(160).easing(Easing.out(Easing.quad))}
      exiting={ZoomOut.duration(120).easing(Easing.out(Easing.quad))}
      style={[styles.fanWrap, { pointerEvents: "none" }, dark ? null : styles.liftShadow]}
    >
      <Svg width={FAN_SIZE} height={FAN_SIZE} viewBox={`${-FAN_CENTER} ${-FAN_CENTER} ${FAN_SIZE} ${FAN_SIZE}`}>
        {WHEEL_OPTIONS.map((option, index) => (
          <FanWedge key={option.mode} index={index} hovered={hovered === index} colors={colors} dark={dark} />
        ))}
      </Svg>
      {WHEEL_OPTIONS.map((option, index) => (
        <FanLabel key={option.mode} index={index} hovered={hovered === index} colors={colors} dark={dark} />
      ))}
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
  const [surface, surfaceSecondary, foreground, background, muted] = useCSSVariable([
    "--surface",
    "--surface-secondary",
    "--foreground",
    "--background",
    "--muted",
  ]) as Array<string | undefined>;
  const colors: WheelColors = { surface, surfaceSecondary, foreground, background, muted };
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
      {wheelOpen ? <Fan hovered={hovered} colors={colors} dark={dark} /> : null}
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
          {wheelOpen ? <Cancel size={20} color={background} /> : <ArrowUp size={20} color={background} />}
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
  // Centered on the send button: the fan's SVG origin is the button center.
  fanWrap: {
    position: "absolute",
    left: BUTTON / 2 - FAN_CENTER,
    top: BUTTON / 2 - FAN_CENTER,
    width: FAN_SIZE,
    height: FAN_SIZE,
    zIndex: 10,
  },
  fanLabel: {
    position: "absolute",
    width: 56,
    alignItems: "center",
  },
  fanLabelText: {
    marginTop: 2,
    fontSize: 11,
    textAlign: "center",
  },
  liftShadow: {
    shadowColor: "#000",
    shadowOpacity: 0.08,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 4 },
  },
});
