import "../../global.css";

import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { HeroUINativeProvider } from "heroui-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <HeroUINativeProvider>
          <StatusBar style="auto" />
          <Stack screenOptions={{ headerShown: false }}>
            {/* Title only — pushed screens show "‹ PiNomad" as their back label. */}
            <Stack.Screen name="index" options={{ title: "PiNomad" }} />
          </Stack>
        </HeroUINativeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
