import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { Alert, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Spinner } from "heroui-native";
import { hostStore } from "../entities/host/secure-host-store.ts";
import type { StoredHost } from "../entities/host/host-store.ts";
import { takePendingPair, type PendingPair } from "../shared/lib/pending-pair.ts";
import { HostConnection, type ConnectSpec } from "../features/connect/host-connection.tsx";
import { PairingForm } from "../features/connect/pairing-form.tsx";

export default function IndexScreen() {
  const router = useRouter();
  const [hosts, setHosts] = useState<StoredHost[]>();
  const [pending, setPending] = useState<PendingPair>();
  // The host to connect to once a pairing is saved — hosts[0] otherwise.
  const [activeKey, setActiveKey] = useState<string>();

  // Every time this screen gains focus, pick up a confirmed pairing and the
  // freshest host list — covers cold start, returning from /pair, and forgets.
  useFocusEffect(
    useCallback(() => {
      let live = true;
      const confirmed = takePendingPair();
      hostStore.list().then((list) => {
        if (!live) return;
        setHosts(list);
        if (confirmed !== undefined) setPending(confirmed);
      });
      return () => {
        live = false;
      };
    }, []),
  );

  const device =
    hosts === undefined
      ? undefined
      : ((activeKey === undefined ? undefined : hosts.find((host) => host.hostKey === activeKey)) ?? hosts[0]);
  const spec: ConnectSpec | undefined =
    pending !== undefined ? { kind: "pair", ...pending } : device === undefined ? undefined : { kind: "device", ...device };

  const forget = (hostKey: string): void => {
    void hostStore.remove(hostKey).then(
      () => {
        setHosts((previous) => previous?.filter((host) => host.hostKey !== hostKey));
        setPending(undefined);
      },
      (error: unknown) =>
        Alert.alert("Couldn't forget this host", error instanceof Error ? error.message : String(error)),
    );
  };

  if (hosts === undefined) {
    return (
      <SafeAreaView className="bg-background" style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <Spinner />
      </SafeAreaView>
    );
  }

  if (spec !== undefined) {
    return (
      <HostConnection
        key={`${spec.kind} ${spec.hostKey}`}
        spec={spec}
        stored={hosts.find((host) => host.hostKey === spec.hostKey)}
        onForget={forget}
        onCancelPair={() => setPending(undefined)}
        onPaired={(host) => {
          setHosts((previous) => [...(previous ?? []).filter((each) => each.hostKey !== host.hostKey), host]);
          // The one-time secret dies here: the spec flips to the stored key and
          // the keyed remount reconnects with plain IK.
          setPending(undefined);
          setActiveKey(host.hostKey);
        }}
      />
    );
  }

  return (
    <SafeAreaView className="bg-background" style={{ flex: 1 }}>
      <View style={{ flex: 1, justifyContent: "center", padding: 24 }}>
        <PairingForm onFragment={(fragment) => router.push({ pathname: "/pair", params: { fragment } })} />
      </View>
      <Text className="text-muted" style={{ textAlign: "center", paddingBottom: 24, fontSize: 12 }}>
        Or open a pinomad://pair link
      </Text>
    </SafeAreaView>
  );
}
