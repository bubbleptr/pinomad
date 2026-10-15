import { Redirect, Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState, type ReactNode } from "react";
import { KeyboardAvoidingView, Platform, Text, View } from "react-native";
import { useHeaderHeight } from "expo-router/react-navigation";
import { Button, Spinner } from "heroui-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import type { DurableView } from "@pinomad/protocol/view.ts";
import { findConversation } from "@pinomad/protocol/organization.ts";
import { displayName } from "@pinomad/client/family.ts";
import { useActiveReconnect, useActiveRemote } from "../../shared/lib/active-remote.ts";
import { useDurableView } from "../../shared/lib/use-remote.ts";
import { showConversation } from "../../shared/lib/conversation-commands.ts";
import { Transcript } from "../../widgets/transcript/transcript.tsx";
import { ConversationComposer } from "../../features/compose/composer.tsx";

export default function ConversationScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const remote = useActiveRemote();
  if (remote === undefined) return <Redirect href="/" />;
  return <ConversationBody remote={remote} id={Number(id) as ConversationId} />;
}

/** Compact offline bar above the transcript; terminal states offer a way out. */
function ConnectionBanner({
  view,
  reconnect,
  onBackToHost,
}: {
  view: DurableView;
  reconnect: (() => void) | undefined;
  onBackToHost(): void;
}) {
  if (view.unauthorized === true) {
    return (
      <BannerRow>
        <Text className="text-danger" style={{ flex: 1, fontSize: 13 }}>
          This device was rejected or revoked
        </Text>
        <Button size="sm" variant="secondary" onPress={onBackToHost}>
          Back to host
        </Button>
      </BannerRow>
    );
  }
  if (view.connection === "outdated") {
    return (
      <BannerRow>
        <Text className="text-danger" style={{ flex: 1, fontSize: 13 }}>
          This host runs an incompatible version
        </Text>
        <Button size="sm" variant="secondary" onPress={onBackToHost}>
          Back to host
        </Button>
      </BannerRow>
    );
  }
  if (view.connection === "reconnecting") {
    return (
      <BannerRow>
        <Spinner size="sm" />
        <Text className="text-muted" style={{ flex: 1, fontSize: 13 }}>
          Reconnecting…
        </Text>
      </BannerRow>
    );
  }
  if (view.connection === "closed") {
    return (
      <BannerRow>
        <Text className="text-danger" style={{ flex: 1, fontSize: 13 }}>
          Disconnected
        </Text>
        {reconnect === undefined ? null : (
          <Button size="sm" variant="secondary" onPress={reconnect}>
            Reconnect
          </Button>
        )}
      </BannerRow>
    );
  }
  return null;
}

function BannerRow({ children }: { children: ReactNode }) {
  return (
    <View
      className="bg-surface-tertiary"
      style={{ flexDirection: "row", alignItems: "center", gap: 8, marginHorizontal: 12, marginTop: 8, borderRadius: 10, padding: 10 }}
    >
      {children}
    </View>
  );
}

function ConversationBody({ remote, id }: { remote: RemoteDurable; id: ConversationId }) {
  const view = useDurableView(remote);
  const headerHeight = useHeaderHeight();
  const router = useRouter();
  // The composer floats over the transcript's tail; its measured height
  // becomes the transcript's bottom inset so the last message stays clear.
  const [composerHeight, setComposerHeight] = useState(0);
  const reconnect = useActiveReconnect();
  // Refused switches resolve with the previous conversation still shown
  // (the reason lands as a notice) — detect via showConversation, not catch.
  const [openFailed, setOpenFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setOpenFailed(false);
    void showConversation(remote, id).then((shown) => {
      if (!cancelled && !shown) setOpenFailed(true);
    });
    return () => {
      cancelled = true;
    };
  }, [remote, id]);

  const summary = findConversation(view.organized, id)?.summary;
  const title = summary === undefined ? "Conversation" : displayName(summary);

  if (openFailed) {
    return (
      <>
        <Stack.Screen options={{ headerShown: true, title }} />
        <SafeAreaView
          className="bg-background"
          style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 12, padding: 24 }}
        >
          <Text className="text-foreground" style={{ textAlign: "center" }}>
            Couldn't open this conversation
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
        <View style={{ flex: 1 }}>
          <ConnectionBanner view={view} reconnect={reconnect} onBackToHost={() => router.back()} />
          <Transcript
            conversation={view.conversation}
            toolPresentations={view.toolPresentations}
            organized={view.organized}
            bottomInset={composerHeight + 8}
            connected={view.connection === "connected"}
            // A subagent's run belongs to the delegating task; resending its
            // prompt would talk past it.
            onRetry={
              summary?.kind === "subagent"
                ? undefined
                : async ({ text, images, requestId }) => {
                    await remote.controller.submit(text, "followUp", { requestId, images });
                  }
            }
          />
          <ConversationComposer remote={remote} view={view} onHeightChange={setComposerHeight} />
        </View>
      </KeyboardAvoidingView>
    </>
  );
}
