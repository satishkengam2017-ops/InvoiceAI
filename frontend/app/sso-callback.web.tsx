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
//
// clerk.handleRedirectCallback()'s returned promise resolves before the
// session is actually established - the installed SDK's isomorphic wrapper
// fires the real work without awaiting it internally. Chaining getToken()
// straight off that await used to see a still-null session and throw,
// silently bouncing the user back to sign-in even though the Google auth
// had succeeded (a second "Continue with Google" click then worked, via
// GoogleSignInButton.web.tsx's isSignedIn fast path, since Clerk had a
// session by then). Reacting to isSignedIn flipping true instead - rather
// than to the handleRedirectCallback promise - waits for the real signal.
const TIMEOUT_MS = 8000;

export default function SSOCallbackWeb() {
  const clerk = useClerk();
  const { getToken, isSignedIn, isLoaded } = useClerkAuth();
  const { signInWithClerk } = useAppAuth();
  const router = useRouter();
  const startedRef = useRef(false);
  const finishedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    clerk.handleRedirectCallback({}).catch(() => {});
  }, [clerk]);

  useEffect(() => {
    if (finishedRef.current || !isLoaded || !isSignedIn) return;
    finishedRef.current = true;

    (async () => {
      try {
        const token = await getToken();
        if (!token) throw new Error("Could not retrieve Google sign-in session.");
        await signInWithClerk(token);
        router.replace("/(app)/dashboard");
      } catch {
        router.replace("/(auth)/sign-in");
      }
    })();
  }, [isLoaded, isSignedIn, getToken, signInWithClerk, router]);

  // Covers genuine failures (denied consent, invalid OAuth state, etc.)
  // that never flip isSignedIn, which would otherwise leave this screen
  // spinning forever.
  useEffect(() => {
    const timer = setTimeout(() => {
      if (finishedRef.current) return;
      finishedRef.current = true;
      router.replace("/(auth)/sign-in");
    }, TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [router]);

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
