import "../../global.css";

import { Stack, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { Button, HeroUINativeProvider } from "heroui-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

function DoneButton() {
  const router = useRouter();
  return (
    <Button variant="ghost" onPress={() => router.back()}>
      Done
    </Button>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <HeroUINativeProvider>
          <StatusBar style="auto" />
          <Stack screenOptions={{ headerShown: false }}>
            {/* Title only — pushed screens show "‹ PiNomad" as their back label. */}
            <Stack.Screen name="index" options={{ title: "PiNomad" }} />
            <Stack.Screen
              name="hosts"
              options={{
                presentation: "modal",
                headerShown: true,
                title: "Hosts",
                headerRight: () => <DoneButton />,
              }}
            />
            <Stack.Screen name="scan" options={{ presentation: "modal", headerShown: true, title: "Scan QR code" }} />
          </Stack>
        </HeroUINativeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
