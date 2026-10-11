import { Redirect, Stack, useRouter } from "expo-router";
import { useState } from "react";
import { KeyboardAvoidingView, Platform, View } from "react-native";
import { useHeaderHeight } from "expo-router/react-navigation";
import { Select } from "heroui-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Home } from "@pinomad/protocol/organization.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import { useActiveRemote } from "../shared/lib/active-remote.ts";
import { useDurableView } from "../shared/lib/use-remote.ts";
import { createAndShow } from "../shared/lib/conversation-commands.ts";
import { useKeyboardVisible } from "../shared/lib/use-keyboard-visible.ts";
import { ComposeBar } from "../features/compose/composer.tsx";

const CHAT: Home = { kind: "chat" };

export default function NewConversationScreen() {
  const remote = useActiveRemote();
  if (remote === undefined) return <Redirect href="/" />;
  return <NewConversationBody remote={remote} />;
}

function NewConversationBody({ remote }: { remote: RemoteDurable }) {
  const router = useRouter();
  const view = useDurableView(remote);
  const headerHeight = useHeaderHeight();
  const insets = useSafeAreaInsets();
  const keyboardVisible = useKeyboardVisible();
  const [home, setHome] = useState<Home>(CHAT);
  const [sending, setSending] = useState(false);

  const projects = view.organized.projects.map((entry) => entry.project);
  const options = [
    { value: "chat", label: "Chat" },
    ...projects.map((project) => ({ value: project.path, label: project.name || project.path })),
  ];

  // Failure rejects so ComposeBar keeps the draft; the notice toast carries
  // the host's reason.
  const send = async (text: string): Promise<void> => {
    setSending(true);
    try {
      const id = await createAndShow(remote, home, text);
      router.replace(`/conversation/${id}`);
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <Stack.Screen options={{ headerShown: true, title: "New conversation" }} />
      <KeyboardAvoidingView
        className="bg-background"
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={headerHeight}
      >
        <View style={{ flex: 1, padding: 16, gap: 16, paddingBottom: keyboardVisible ? 16 : insets.bottom + 16 }}>
          <Select
            value={options.find((option) => option.value === (home.kind === "chat" ? "chat" : home.path))}
            onValueChange={(option) =>
              setHome(option === undefined || option.value === "chat" ? CHAT : { kind: "project", path: option.value })
            }
          >
            <Select.Trigger>
              <Select.Value placeholder="Where the conversation lives" />
              <Select.TriggerIndicator />
            </Select.Trigger>
            <Select.Portal>
              <Select.Overlay />
              <Select.Content presentation="popover">
                {options.map((option) => (
                  <Select.Item key={option.value} value={option.value} label={option.label} />
                ))}
              </Select.Content>
            </Select.Portal>
          </Select>
          <View style={{ flex: 1 }} />
          <ComposeBar
            disabled={view.connection !== "connected" || sending}
            placeholder="First message…"
            onSubmit={(text) => send(text)}
          />
        </View>
      </KeyboardAvoidingView>
    </>
  );
}
