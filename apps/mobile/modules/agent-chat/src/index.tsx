// JS side of the spike module. The native views take a full JSON snapshot of
// the run (see src/widgets/transcript/native-run.ts for the adapter); Swift
// decodes it into AgentChatKit's model on every prop update.
import { requireNativeView } from "expo";
import { Platform, type StyleProp, type ViewStyle } from "react-native";
import type { ComponentType } from "react";

export type NativeRunProps = {
  /** JSON-encoded RunTracePayload / RunAnswerPayload. */
  payload: string;
  style?: StyleProp<ViewStyle>;
};

export const NativeRunTrace: ComponentType<NativeRunProps> =
  requireNativeView<NativeRunProps>("PinomadAgentChat", "RunTraceView");

export const NativeRunAnswer: ComponentType<NativeRunProps> =
  requireNativeView<NativeRunProps>("PinomadAgentChat", "RunAnswerView");

/**
 * The spike builds AgentChatKit at an iOS 18 floor, so any iOS install can
 * take the native path. Android keeps the RN fallback: the module's views
 * are registered there but render empty.
 */
export function nativeTranscriptSupported(): boolean {
  return Platform.OS === "ios";
}
