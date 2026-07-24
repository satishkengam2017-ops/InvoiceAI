import { useAuth as useClerkAuth, useSSO } from "@clerk/expo";
import React, { useState } from "react";
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity } from "react-native";

import { useAuth as useAppAuth } from "@/src/context/AuthContext";
import { colors, radius, spacing, typography } from "@/src/lib/theme";

type Props = {
  onError: (message: string) => void;
};

export function GoogleSignInButton({ onError }: Props) {
  const { startSSOFlow } = useSSO();
  const { getToken } = useClerkAuth();
  const { signInWithClerk } = useAppAuth();
  const [busy, setBusy] = useState(false);

  const onPress = async () => {
    setBusy(true);
    try {
      const { createdSessionId, setActive, signIn, signUp } = await startSSOFlow({
        strategy: "oauth_google",
      });
      if (!createdSessionId || !setActive) {
        // Clerk returns a signIn/signUp object with a status (e.g.
        // "needs_second_factor", "missing_requirements") when the flow got
        // partway through but needs another step we don't support yet — show
        // a neutral message rather than leaving the user staring at nothing.
        // With no status at all, the user simply closed the popup: stay silent.
        const status = signIn?.status || signUp?.status;
        if (status) {
          onError("Sign-in didn't complete. Please try again.");
        }
        return;
      }
      await setActive({ session: createdSessionId });
      const token = await getToken();
      if (!token) throw new Error("Could not retrieve Google sign-in session.");
      await signInWithClerk(token);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Google sign-in failed");
    } finally {
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
