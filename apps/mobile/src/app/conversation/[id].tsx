import { Redirect, Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { KeyboardAvoidingView, Platform, Text, View } from "react-native";
import { useHeaderHeight } from "expo-router/react-navigation";
import { Button, Spinner } from "heroui-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import { findConversation } from "@pinomad/protocol/organization.ts";
import { displayName } from "@pinomad/client/family.ts";
import { useActiveRemote } from "../../shared/lib/active-remote.ts";
import { useDurableView } from "../../shared/lib/use-remote.ts";
import { useKeyboardVisible } from "../../shared/lib/use-keyboard-visible.ts";
import { Transcript } from "../../widgets/transcript/transcript.tsx";
import { PendingQuestions } from "../../features/answer-question/pending-questions.tsx";
import { ConversationComposer } from "../../features/compose/composer.tsx";

export default function ConversationScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const remote = useActiveRemote();
  if (remote === undefined) return <Redirect href="/" />;
  return <ConversationBody remote={remote} id={Number(id) as ConversationId} />;
}

function ConversationBody({ remote, id }: { remote: RemoteDurable; id: ConversationId }) {
  const view = useDurableView(remote);
  const headerHeight = useHeaderHeight();
  const router = useRouter();
  // The bottom inset keeps the composer off the home indicator; it must go
  // away while the keyboard is open or the composer floats above the keys.
  const insets = useSafeAreaInsets();
  const keyboardVisible = useKeyboardVisible();
  const [switchError, setSwitchError] = useState<string | undefined>(undefined);
  useEffect(() => {
    setSwitchError(undefined);
    remote.controller.switchConversation(id).catch((error: unknown) => {
      setSwitchError(error instanceof Error ? error.message : String(error));
    });
  }, [remote, id]);

  const summary = findConversation(view.organized, id)?.summary;
  const title = summary === undefined ? "Conversation" : displayName(summary);

  if (switchError !== undefined) {
    return (
      <>
        <Stack.Screen options={{ headerShown: true, title }} />
        <SafeAreaView
          className="bg-background"
          style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 12, padding: 24 }}
        >
          <Text className="text-danger" style={{ textAlign: "center" }}>
            {switchError}
          </Text>
          <Button variant="secondary" onPress={() => router.back()}>
            Back
          </Button>
        </SafeAreaView>
      </>
    );
  }

  if (view.conversation?.conversation.id !== id) {
    return (
      <>
        <Stack.Screen options={{ headerShown: true, title }} />
        <SafeAreaView className="bg-background" style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <Spinner />
        </SafeAreaView>
      </>
    );
  }

  return (
    <>
      <Stack.Screen options={{ headerShown: true, title }} />
      <KeyboardAvoidingView
        className="bg-background"
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={headerHeight}
      >
        <View style={{ flex: 1, paddingBottom: keyboardVisible ? 0 : insets.bottom }}>
          <Transcript
            conversation={view.conversation}
            toolPresentations={view.toolPresentations}
            organized={view.organized}
          />
          <PendingQuestions docs={view.docs} remote={remote} connected={view.connection === "connected"} />
          <ConversationComposer remote={remote} view={view} />
        </View>
      </KeyboardAvoidingView>
    </>
  );
}
