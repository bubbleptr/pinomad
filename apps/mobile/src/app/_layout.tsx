import "../../global.css";

import { DarkTheme, DefaultTheme, Stack, ThemeProvider, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useColorScheme } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { Button, HeroUINativeProvider } from "heroui-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { useCSSVariable } from "uniwind";

function DoneButton() {
  const router = useRouter();
  return (
    <Button variant="ghost" onPress={() => router.back()}>
      Done
    </Button>
  );
}

function CancelButton() {
  const router = useRouter();
  return (
    <Button variant="ghost" onPress={() => router.back()}>
      Cancel
    </Button>
  );
}

export default function RootLayout() {
  // Without a navigation theme headers keep the light palette in dark mode —
  // the ghost Cancel becomes white-on-white. Card/background follow the
  // HeroUI surface so the chrome doesn't sit on a different dark.
  const base = useColorScheme() === "dark" ? DarkTheme : DefaultTheme;
  const background = useCSSVariable("--background") as string | undefined;
  const theme = {
    ...base,
    colors: { ...base.colors, ...(background === undefined ? {} : { background, card: background }) },
  };
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <HeroUINativeProvider>
          <ThemeProvider value={theme}>
            <StatusBar style="auto" />
            <Stack screenOptions={{ headerShown: false, headerBackButtonDisplayMode: "minimal" }}>
              {/* Title only — pushed screens show an icon-only back chevron. */}
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
              <Stack.Screen
                name="add-project"
                options={{
                  presentation: "modal",
                  headerShown: true,
                  title: "Add project",
                  headerLeft: () => <CancelButton />,
                }}
              />
            </Stack>
          </ThemeProvider>
        </HeroUINativeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
