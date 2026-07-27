import { useAuth as useClerkAuth, useSignIn } from "@clerk/expo";
import React, { useState } from "react";
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity } from "react-native";

import { useAuth as useAppAuth } from "@/src/context/AuthContext";
import { colors, radius, spacing, typography } from "@/src/lib/theme";

type Props = {
  onError: (message: string) => void;
};

// useSSO()'s startSSOFlow (native's GoogleSignInButton.tsx) is popup-based
// via expo-web-browser and is not reliable on web - on web it can fail
// silently with no popup, no network call, and no error. Web instead uses
// Clerk's own redirect-based flow via the SignInFuture API's sso() method
// (this Clerk version's useSignIn() returns a "future" resource, not the
// classic one - authenticateWithRedirect() lives only on the classic API).
// It does a full-page navigation to Google and back, completed by
// sso-callback.web.tsx.
export function GoogleSignInButton({ onError }: Props) {
  const { signIn } = useSignIn();
  const { getToken, isSignedIn } = useClerkAuth();
  const { signInWithClerk } = useAppAuth();
  const [busy, setBusy] = useState(false);

  const onPress = async () => {
    setBusy(true);
    try {
      // A Clerk-level session can already exist here (e.g. from a previous
      // Google sign-in attempt) even though our own app considers the user
      // signed out - Clerk's session and our own JWT are tracked
      // independently. Starting a *new* OAuth flow in that state fails with
      // Clerk's "session_exists" error ("You're already signed in."), since
      // this app only allows one session at a time. Exchange the existing
      // session with our backend instead of starting a new redirect.
      if (isSignedIn) {
        const token = await getToken();
        if (!token) throw new Error("Could not retrieve your existing Google sign-in session.");
        await signInWithClerk(token);
        return;
      }
      if (!signIn) throw new Error("Google sign-in is not ready yet. Please try again.");
      const { error } = await signIn.sso({
        strategy: "oauth_google",
        redirectUrl: "/sso-callback",
        redirectCallbackUrl: "/sso-callback",
      });
      // longMessage is Clerk's user-facing text (message is for developers
      // and isn't guaranteed stable) - this is likely the source of the
      // "You're already signed in." text seen for the session_exists case.
      if (error) throw new Error(error.longMessage ?? error.message ?? "Google sign-in failed");
      // On success this navigates the browser away to Google; there is no
      // further code to run here, and setBusy(false) below never runs
      // before the page unloads.
    } catch (e) {
      onError(e instanceof Error ? e.message : "Google sign-in failed");
      setBusy(false);
    }
  };

  return (
    <TouchableOpacity
      testID="continue-with-google"
      style={styles.btn}
      onPress={onPress}
      disabled={busy}
      activeOpacity={0.85}
    >
      {busy ? (
        <ActivityIndicator color={colors.onSurface} />
      ) : (
        <Text style={styles.text}>Continue with Google</Text>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  btn: {
    minHeight: 48,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceSecondary,
    alignItems: "center",
    justifyContent: "center",
    marginTop: spacing.md,
  },
  text: { fontSize: typography.lg, fontWeight: "500", color: colors.onSurface },
});
