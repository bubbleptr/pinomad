import { useLocalSearchParams, useRouter } from "expo-router";
import { useMemo } from "react";
import { Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "heroui-native";
import { parsePairParam } from "@pinomad/protocol/pairing-link.ts";
import { setPendingPair, type PendingPair } from "../shared/lib/pending-pair.ts";
import { PairConfirm } from "../features/connect/pair-confirm.tsx";

function parseFragment(fragment: string): PendingPair | undefined {
  const params = new URLSearchParams(fragment);
  const pair = params.get("pair");
  const url = params.get("url");
  if (pair === null || url === null) return undefined;
  const parsed = parsePairParam(pair);
  if (parsed === undefined) return undefined;
  return { url, hostKey: parsed.hostKey, secret: parsed.secret };
}

/** Confirm step for a pairing link — pasted (pushed with `fragment`) or deep-linked. */
export default function PairScreen() {
  const router = useRouter();
  // `fragment` is normalized by +native-intent (deep links) or the paste form.
  const { fragment } = useLocalSearchParams<{ fragment?: string }>();
  const pending = useMemo(() => (fragment === undefined ? undefined : parseFragment(fragment)), [fragment]);

  const leave = (): void => {
    if (router.canGoBack()) router.back();
    else router.replace("/");
  };

  // After confirming, land on index explicitly: /pair may sit above the /hosts
  // or /scan modals, and back() there would strand the pending pair behind the
  // modal — index's focus effect only consumes it once index is on top.
  const confirm = (): void => {
    if (pending === undefined) return;
    setPendingPair(pending);
    if (router.canDismiss()) router.dismissTo("/");
    else router.replace("/");
  };

  return (
    <SafeAreaView className="bg-background" style={{ flex: 1 }}>
      <View style={{ flex: 1, justifyContent: "center", padding: 24 }}>
        {pending === undefined ? (
          <View style={{ gap: 16 }}>
            <Text className="text-foreground" style={{ fontSize: 17, fontWeight: "600", textAlign: "center" }}>
              This pairing link is invalid
            </Text>
            <Text className="text-muted" style={{ textAlign: "center" }}>
              Ask for a fresh link from `pinomad pair` or Devices → Pair a device.
            </Text>
            <Button variant="secondary" onPress={leave}>
              Back
            </Button>
          </View>
        ) : (
          <PairConfirm
            url={pending.url}
            // The secret leaves the route here: it moves into memory only.
            onPair={confirm}
            onCancel={leave}
          />
        )}
      </View>
    </SafeAreaView>
  );
}
