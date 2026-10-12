// The message input. Collapsed it's a single-row floating capsule over the
// transcript; focusing the input grows it into a card (grabber, tall field,
// actions row). One fixed tree keeps the TextInput mounted across the switch
// or the collapse→expand transition would drop focus.
// ConversationComposer wires it to the remote (status pill, queued
// steers/follow-ups, abort, pending questions, compact menu); the bare
// ComposeBar is reused by the new-conversation screen where there is no run
// to stop or queue.
import { useRef, useState, type ReactNode } from "react";
import { ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Menu } from "heroui-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { LinearTransition } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { useCSSVariable, useUniwind } from "uniwind";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { isBusy } from "@pinomad/protocol/transcript.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import type { DurableView } from "@pinomad/protocol/view.ts";
import { agentOf, queueItems, statusText } from "@pinomad/client/chat.ts";
import { ChatAdd, Computer, FolderLibrary, GitBranch, Plus } from "../../shared/ui/icons.tsx";
import { useKeyboardVisible } from "../../shared/lib/use-keyboard-visible.ts";
import { LocationChip, LocationRow } from "../../entities/checkout/location-row.tsx";
import { ModelSheet } from "../../entities/model/model-sheet.tsx";
import { PendingQuestions } from "../answer-question/pending-questions.tsx";
import { SendSlot } from "./send-button.tsx";

const QUEUE_TAGS = { steer: "Steer", followUp: "Follow-up", write: "Queued" } as const;

function Grabber({ onDismiss }: { onDismiss(): void }) {
  const muted = useCSSVariable("--muted") as string | undefined;
  // A downward pull on the strip blurs the input, folding the card back to
  // the capsule (unless forced expanded); translation or a flick both count.
  const pan = Gesture.Pan()
    .activeOffsetY(10)
    .onEnd((e) => {
      "worklet";
      if (e.translationY > 24 || e.velocityY > 500) scheduleOnRN(onDismiss);
    });
  return (
    <GestureDetector gesture={pan}>
      <View style={styles.grabberStrip}>
        <View style={[styles.grabber, { backgroundColor: muted }]} />
      </View>
    </GestureDetector>
  );
}

function PlusMenu({ remote, connected }: { remote: RemoteDurable; connected: boolean }) {
  const [surfaceTertiary, muted] = useCSSVariable(["--surface-tertiary", "--muted"]) as Array<string | undefined>;
  return (
    <Menu>
      <Menu.Trigger
        accessibilityRole="button"
        accessibilityLabel="More actions"
        hitSlop={4}
        isDisabled={!connected}
        style={[styles.circle, { backgroundColor: surfaceTertiary, opacity: connected ? 1 : 0.4 }]}
      >
        <Plus size={20} color={muted} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Overlay />
        <Menu.Content presentation="popover" placement="top" align="start" width={220}>
          <Menu.Item isDisabled={!connected} onPress={() => void remote.controller.compact(undefined)}>
            <Menu.ItemTitle>Compact conversation</Menu.ItemTitle>
          </Menu.Item>
        </Menu.Content>
      </Menu.Portal>
    </Menu>
  );
}

export function ComposeBar({
  disabled,
  busy = false,
  placeholder = "Message…",
  onSubmit,
  onStop,
  expanded = false,
  autoFocus = false,
  startAction,
  modelAction,
  footer,
}: {
  disabled: boolean;
  busy?: boolean;
  placeholder?: string;
  /** Returning a promise delays the clear until it resolves; rejection keeps the text. */
  onSubmit(text: string, whenBusy: "steer" | "followUp"): void | Promise<void>;
  onStop?(): void;
  /** Force the expanded card (new-conversation screen) regardless of focus. */
  expanded?: boolean;
  autoFocus?: boolean;
  /** The leading + affordance; omitted where there is nothing to put behind it. */
  startAction?: ReactNode;
  /** The model · thinking capsule; expanded only, right after startAction. */
  modelAction?: ReactNode;
  /** A row inside the card under the actions row (location chips); expanded only. */
  footer?: ReactNode;
}) {
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<TextInput>(null);
  const [fieldPlaceholder, border, muted] = useCSSVariable([
    "--field-placeholder",
    "--border",
    "--muted",
  ]) as Array<string | undefined>;
  const dark = useUniwind().theme === "dark";
  const isExpanded = expanded || focused;
  const empty = text.trim() === "";
  const send = (whenBusy: "steer" | "followUp"): void => {
    if (disabled || empty) return;
    const result = onSubmit(text, whenBusy);
    if (result === undefined) {
      setText("");
      return;
    }
    result.then(
      () => setText(""),
      () => {},
    );
  };
  const sendSlot = <SendSlot hasText={!empty} busy={busy} disabled={disabled} onSend={send} onStop={onStop} />;
  return (
    <Animated.View
      layout={LinearTransition.duration(200)}
      className="bg-surface"
      style={[
        styles.card,
        { borderColor: border },
        isExpanded ? styles.cardExpanded : styles.cardCollapsed,
        dark ? null : styles.cardShadow,
      ]}
    >
      {isExpanded ? <Grabber onDismiss={() => inputRef.current?.blur()} /> : null}
      <View style={[styles.mainRow, isExpanded ? null : styles.mainRowCollapsed]}>
        {isExpanded ? null : startAction}
        <TextInput
          ref={inputRef}
          className="text-foreground"
          style={[styles.input, isExpanded ? styles.inputExpanded : styles.inputCollapsed]}
          multiline
          autoFocus={autoFocus}
          placeholder={placeholder}
          placeholderTextColor={fieldPlaceholder}
          value={text}
          onChangeText={setText}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          editable={!disabled}
          testID="composer-input"
        />
        {isExpanded ? null : sendSlot}
      </View>
      {/* The actions row stays mounted (display:none) while collapsed so the
          model sheet inside modelAction survives Keyboard.dismiss() blurring
          the input — blur collapses the card, and an unmount would kill the
          open sheet. */}
      <View style={[styles.actionsRow, isExpanded ? undefined : styles.hidden]}>
        {startAction}
        {modelAction}
        <View style={styles.spacer} />
        {sendSlot}
      </View>
      {isExpanded && footer !== undefined ? <View style={styles.footerRow}>{footer}</View> : null}
    </Animated.View>
  );
}

export function ConversationComposer({
  remote,
  view,
  onHeightChange,
}: {
  remote: RemoteDurable;
  view: DurableView;
  /** Reports the floating stack's height so the transcript can stay clear of it. */
  onHeightChange?(height: number): void;
}) {
  const conversation = view.conversation;
  const busy = conversation !== undefined && isBusy(conversation);
  const status = conversation === undefined ? "" : statusText(conversation);
  const queued = conversation === undefined ? [] : queueItems(conversation);
  const connected = view.connection === "connected";
  const insets = useSafeAreaInsets();
  const keyboardVisible = useKeyboardVisible();
  const border = useCSSVariable("--border") as string | undefined;
  const agent = conversation === undefined ? undefined : agentOf(conversation);
  const isProject = view.home?.kind === "project";
  const checkout = view.checkout;
  return (
    <View
      pointerEvents="box-none"
      style={[styles.floating, { paddingBottom: 8 + (keyboardVisible ? 0 : insets.bottom) }]}
      onLayout={(e) => onHeightChange?.(e.nativeEvent.layout.height)}
    >
      <PendingQuestions docs={view.docs} remote={remote} connected={connected} />
      {status === "" ? null : (
        <View className="bg-surface" style={[styles.statusPill, { borderColor: border }]}>
          <Text className="text-muted" style={{ fontSize: 13 }}>
            {status}
          </Text>
        </View>
      )}
      {queued.length === 0 ? null : (
        // Capped at ~3 rows so a long queue can't push the composer off screen.
        <ScrollView style={styles.queueScroll} contentContainerStyle={{ gap: 4 }}>
          {queued.map((item) => (
            <View key={item.id} className="bg-surface" style={[styles.queueRow, { borderColor: border }]}>
              <Text className="text-foreground" style={{ flex: 1, fontSize: 13 }} numberOfLines={1}>
                {item.text}
              </Text>
              <Text className="text-muted" style={{ fontSize: 12 }}>
                {QUEUE_TAGS[item.mode]}
              </Text>
            </View>
          ))}
        </ScrollView>
      )}
      <ComposeBar
        disabled={!connected}
        busy={busy}
        placeholder={busy ? "Follow up…" : "Ask the agent…"}
        onSubmit={(text, whenBusy) => void remote.controller.submit(text, whenBusy)}
        onStop={() => void remote.controller.abort()}
        startAction={<PlusMenu remote={remote} connected={connected} />}
        modelAction={
          agent === undefined ? undefined : (
            <ModelSheet
              models={view.models}
              selected={{ model: agent.model, level: agent.thinkingLevel ?? "off" }}
              isDisabled={!connected}
              onModelChange={(model) => void remote.controller.setModel(model)}
              onLevelChange={(level) => void remote.controller.setThinkingLevel(level)}
            />
          )
        }
        footer={
          // Static chips (web parity): the location is fixed once the
          // conversation exists; only the draft screen offers pickers.
          <LocationRow>
            {isProject ? (
              checkout === undefined ? (
                <LocationChip icon={Computer} label="Project folder" testID="composer-location" />
              ) : (
                <>
                  <LocationChip icon={FolderLibrary} label="Git worktree" testID="composer-location" />
                  <LocationChip icon={GitBranch} label={checkout.branch} muted testID="composer-branch" />
                </>
              )
            ) : (
              <LocationChip icon={ChatAdd} label="Chat" testID="composer-location" />
            )}
          </LocationRow>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  floating: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 12,
    gap: 6,
    // The stack sits inside the KeyboardAvoidingView's shrinking parent, so
    // it can never exceed the space above the keyboard.
    maxHeight: "100%",
  },
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    // The input card keeps its height; scrollables above it shrink first.
    flexShrink: 0,
  },
  cardCollapsed: {
    height: 52,
    borderRadius: 26,
    paddingHorizontal: 8,
    justifyContent: "center",
  },
  cardExpanded: {
    borderRadius: 28,
    padding: 12,
    gap: 4,
  },
  // Depth in light mode; dark mode relies on the hairline border alone.
  cardShadow: {
    shadowColor: "#000",
    shadowOpacity: 0.08,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 4 },
  },
  grabberStrip: {
    height: 24,
    marginTop: -8,
    alignItems: "center",
    justifyContent: "center",
  },
  grabber: {
    width: 36,
    height: 5,
    borderRadius: 3,
  },
  mainRow: {
    flexDirection: "row",
    gap: 8,
  },
  mainRowCollapsed: {
    alignItems: "center",
    height: 36,
  },
  input: {
    flex: 1,
    fontSize: 16,
    paddingHorizontal: 4,
  },
  inputCollapsed: {
    height: 36,
    paddingVertical: 7,
  },
  inputExpanded: {
    minHeight: 88,
    maxHeight: 200,
    paddingVertical: 4,
  },
  actionsRow: {
    flexDirection: "row",
    alignItems: "center",
    height: 36,
    gap: 4,
  },
  hidden: {
    display: "none",
  },
  footerRow: {
    marginTop: 2,
  },
  spacer: {
    flex: 1,
  },
  circle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  statusPill: {
    alignSelf: "flex-start",
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  queueScroll: {
    maxHeight: 104,
    // Shares vertical space with the questions list; both shrink and scroll
    // before the input card gives up any of its height.
    flexShrink: 1,
  },
  queueRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
});
