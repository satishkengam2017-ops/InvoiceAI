import { useClerk, useAuth as useClerkAuth } from "@clerk/expo";
import { useRouter } from "expo-router";
import { useEffect, useRef } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";

import { useAuth as useAppAuth } from "@/src/context/AuthContext";
import { colors } from "@/src/lib/theme";

// Completes the full-page-redirect OAuth flow started by
// signIn.authenticateWithRedirect() in GoogleSignInButton.web.tsx. Unlike
// native's popup-based useSSO() flow (sso-callback.tsx), a redirect flow
// lands back here as a brand-new page load, so this route has to finish the
// Clerk handshake itself rather than just closing a popup.
export default function SSOCallbackWeb() {
  const clerk = useClerk();
  const { getToken } = useClerkAuth();
  const { signInWithClerk } = useAppAuth();
  const router = useRouter();
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;

    (async () => {
      try {
        await clerk.handleRedirectCallback({});
        const token = await getToken();
        if (!token) throw new Error("Could not retrieve Google sign-in session.");
        await signInWithClerk(token);
        router.replace("/(app)/dashboard");
      } catch {
        router.replace("/(auth)/sign-in");
      }
    })();
  }, [clerk, getToken, signInWithClerk, router]);

  return (
    <View style={styles.wrap}>
      <ActivityIndicator size="large" color={colors.brand} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
  },
});
