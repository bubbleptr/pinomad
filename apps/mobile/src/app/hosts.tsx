// Saved hosts: tap to switch (setActive → index reconnects on focus), Forget
// per row. "Pair another host" offers camera scan or paste — pairing lands
// back on index via the pending-pair handoff.
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { Alert, Pressable, ScrollView, Text, View } from "react-native";
import { Button, Spinner } from "heroui-native";
import { hostLabels } from "@pinomad/client/stored-host.ts";
import { hostStore } from "../entities/host/secure-host-store.ts";
import type { StoredHost } from "../entities/host/host-store.ts";
import { PairingForm } from "../features/connect/pairing-form.tsx";

export default function HostsScreen() {
  const router = useRouter();
  const [hosts, setHosts] = useState<StoredHost[]>();
  const [active, setActive] = useState<string>();

  const refresh = useCallback(
    () =>
      Promise.all([hostStore.list(), hostStore.activeKey()]).then(([list, activeKey]) => {
        setHosts(list);
        setActive(activeKey);
        return list;
      }),
    [],
  );
  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );

  const forget = (host: StoredHost, label: string): void => {
    Alert.alert(`Forget ${label}?`, `This device will need a new pairing link to reconnect.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Forget",
        style: "destructive",
        onPress: () =>
          void hostStore
            .remove(host.hostKey)
            .then(refresh)
            .then((list) => {
              // Nothing left → index's empty state is the only sensible screen.
              if (list.length === 0) router.back();
            }),
      },
    ]);
  };

  const labels = hostLabels(hosts ?? []);

  return (
    <ScrollView className="bg-background" contentContainerStyle={{ padding: 16, gap: 8 }}>
      {hosts === undefined ? (
        <View style={{ paddingVertical: 32, alignItems: "center" }}>
          <Spinner />
        </View>
      ) : (
        hosts.map((host) => {
          const isActive = host.hostKey === (active ?? hosts[0]?.hostKey);
          const label = labels.get(host.hostKey) ?? host.url;
          return (
            <Pressable
              key={host.hostKey}
              onPress={() => {
                void hostStore.setActive(host.hostKey).then(() => router.back());
              }}
              style={({ pressed }) => ({
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
                paddingVertical: 12,
                paddingHorizontal: 12,
                borderRadius: 10,
                opacity: pressed ? 0.6 : 1,
              })}
            >
              <Text className="text-foreground" style={{ flex: 1, fontSize: 16 }} numberOfLines={1}>
                {label}
              </Text>
              {isActive ? (
                <Text className="text-accent" style={{ fontSize: 16 }}>
                  ✓
                </Text>
              ) : null}
              <Button
                size="sm"
                variant="ghost"
                onPress={() => forget(host, label)}
              >
                Forget
              </Button>
            </Pressable>
          );
        })
      )}
      <View style={{ gap: 8, marginTop: 16 }}>
        <Text className="text-muted" style={{ fontSize: 13, fontWeight: "600" }}>
          Pair another host
        </Text>
        <Button variant="secondary" onPress={() => router.push("/scan")}>
          Scan QR code
        </Button>
        <PairingForm onFragment={(fragment) => router.push({ pathname: "/pair", params: { fragment } })} />
      </View>
    </ScrollView>
  );
}
