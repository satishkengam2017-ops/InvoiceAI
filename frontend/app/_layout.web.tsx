import { ClerkProvider } from "@clerk/expo";
import { tokenCache } from "@clerk/expo/token-cache";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { useEffect } from "react";
import { LogBox } from "react-native";

import { useIconFonts } from "@/src/hooks/use-icon-fonts";
import { injectWebShell } from "@/src/lib/webShell";
import { RootProviders } from "@/src/providers/RootProviders";

const CLERK_PUBLISHABLE_KEY = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY;

if (!CLERK_PUBLISHABLE_KEY) {
  throw new Error("Add EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY to frontend/.env");
}

LogBox.ignoreAllLogs(true);

injectWebShell();

SplashScreen.preventAutoHideAsync();

export default function RootLayoutWeb() {
  const [loaded, error] = useIconFonts();

  useEffect(() => {
    if (loaded || error) {
      SplashScreen.hideAsync();
    }
  }, [loaded, error]);

  if (!loaded && !error) return null;

  return (
    <ClerkProvider publishableKey={CLERK_PUBLISHABLE_KEY} tokenCache={tokenCache}>
      <RootProviders>
        <Stack screenOptions={{ headerShown: false, animation: "fade" }} />
      </RootProviders>
    </ClerkProvider>
  );
}
