import { useRouter } from "expo-router";
import React, { useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Button } from "@/src/components/Button";
import { Input } from "@/src/components/Input";
import { api } from "@/src/lib/api";
import { colors, spacing, typography, webContent } from "@/src/lib/theme";

export default function ForgotPassword() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const onSubmit = async () => {
    setErr(null);
    setLoading(true);
    try {
      await api.post("/auth/forgot-password", { email: email.trim().toLowerCase() });
      router.push({ pathname: "/(auth)/reset-password", params: { email: email.trim().toLowerCase() } });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={[styles.scroll, webContent]} keyboardShouldPersistTaps="handled">
          <View style={styles.brand}>
            <Text style={styles.brandMark}>Forgot password?</Text>
            <Text style={styles.subtitle}>
              Enter your email and we'll send you a 6-digit code to reset your password.
            </Text>
          </View>

          <View style={styles.form}>
            <Input
              testID="forgot-password-email"
              label="Email"
              autoCapitalize="none"
              keyboardType="email-address"
              autoComplete="email"
              value={email}
              onChangeText={setEmail}
              placeholder="you@company.com"
            />
            {err ? <Text style={styles.err}>{err}</Text> : null}
            <Button testID="forgot-password-submit" title="Send code" loading={loading} onPress={onSubmit} />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.surface },
  scroll: { flexGrow: 1, padding: spacing.xl, justifyContent: "center" },
  brand: { marginBottom: spacing.xxxl },
  brandMark: {
    fontSize: 28,
    fontWeight: "600",
    color: colors.onSurface,
    letterSpacing: -0.5,
  },
  subtitle: {
    fontSize: typography.lg,
    color: colors.muted,
    marginTop: spacing.md,
    lineHeight: 22,
  },
  form: {},
  err: {
    color: colors.error,
    fontSize: typography.base,
    marginBottom: spacing.md,
  },
});
