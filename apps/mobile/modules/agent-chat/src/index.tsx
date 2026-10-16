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
 * AgentChatKit needs iOS 26. Below it (and on Android) the module's views are
 * still registered but render empty, so the transcript must keep its RN path.
 */
export function nativeTranscriptSupported(): boolean {
  return Platform.OS === "ios" && Number.parseFloat(String(Platform.Version)) >= 26;
}
