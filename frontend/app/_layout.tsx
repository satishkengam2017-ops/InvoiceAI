import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { useEffect } from "react";
import { LogBox } from "react-native";

import { useIconFonts } from "@/src/hooks/use-icon-fonts";
import { RootProviders } from "@/src/providers/RootProviders";

LogBox.ignoreAllLogs(true);

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const [loaded, error] = useIconFonts();

  useEffect(() => {
    if (loaded || error) {
      SplashScreen.hideAsync();
    }
  }, [loaded, error]);

  if (!loaded && !error) return null;

  return (
    <RootProviders>
      <Stack screenOptions={{ headerShown: false, animation: "fade" }} />
    </RootProviders>
  );
}
