// The message input. ConversationComposer wires it to the remote (status
// line, queued steers/follow-ups, abort); the bare ComposeBar is reused by
// the new-conversation screen where there is no run to stop or queue.
import { useState } from "react";
import { Text, TextInput, View } from "react-native";
import { Button } from "heroui-native";
import { useCSSVariable } from "uniwind";
import { isBusy } from "@pinomad/protocol/transcript.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import type { DurableView } from "@pinomad/protocol/view.ts";
import { queueItems, statusText } from "@pinomad/client/chat.ts";

export function ComposeBar({
  disabled,
  busy = false,
  placeholder = "Message…",
  onSubmit,
  onStop,
}: {
  disabled: boolean;
  busy?: boolean;
  placeholder?: string;
  /** Returning a promise delays the clear until it resolves; rejection keeps the text. */
  onSubmit(text: string, whenBusy: "steer" | "followUp"): void | Promise<void>;
  onStop?(): void;
}) {
  const [text, setText] = useState("");
  const fieldPlaceholder = useCSSVariable("--field-placeholder") as string | undefined;
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
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 8 }}>
      <TextInput
        className="bg-surface-tertiary text-foreground"
        style={{ flex: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16, maxHeight: 120 }}
        multiline
        placeholder={placeholder}
        placeholderTextColor={fieldPlaceholder}
        value={text}
        onChangeText={setText}
        editable={!disabled}
        testID="composer-input"
      />
      {busy && onStop !== undefined ? (
        <Button variant="secondary" onPress={onStop} isDisabled={disabled}>
          Stop
        </Button>
      ) : null}
      {busy && !empty ? (
        <Button variant="secondary" onPress={() => send("followUp")} isDisabled={disabled}>
          Follow-up
        </Button>
      ) : null}
      <Button onPress={() => send("steer")} isDisabled={disabled || empty}>
        Send
      </Button>
    </View>
  );
}

export function ConversationComposer({ remote, view }: { remote: RemoteDurable; view: DurableView }) {
  const conversation = view.conversation;
  const busy = conversation !== undefined && isBusy(conversation);
  const status = conversation === undefined ? "" : statusText(conversation);
  const queued = conversation === undefined ? [] : queueItems(conversation);
  const connected = view.connection === "connected";
  return (
    <View style={{ gap: 6, paddingHorizontal: 12, paddingTop: 4, paddingBottom: 8 }}>
      {status === "" ? null : (
        <Text className="text-muted" style={{ fontSize: 13 }}>
          {status}
        </Text>
      )}
      {queued.map((item) => (
        <Text key={item.id} className="text-muted" style={{ fontSize: 13 }} numberOfLines={1}>
          {item.mode === "steer" ? "Steer" : item.mode === "followUp" ? "Follow-up" : "Queued"}: {item.text}
        </Text>
      ))}
      <ComposeBar
        disabled={!connected}
        busy={busy}
        onSubmit={(text, whenBusy) => void remote.controller.submit(text, whenBusy)}
        onStop={() => void remote.controller.abort()}
      />
    </View>
  );
}
