import { useLocalSearchParams, useRouter } from "expo-router";
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

export default function ResetPassword() {
  const router = useRouter();
  const { email: emailParam } = useLocalSearchParams<{ email?: string }>();
  const [email, setEmail] = useState(emailParam ?? "");
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const onSubmit = async () => {
    setErr(null);
    if (newPassword.length < 6) return setErr("Password must be at least 6 characters");
    if (newPassword !== confirmPassword) return setErr("Passwords do not match");
    setLoading(true);
    try {
      await api.post("/auth/reset-password", {
        email: email.trim().toLowerCase(),
        code: code.trim(),
        new_password: newPassword,
      });
      router.replace("/(auth)/sign-in");
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
            <Text style={styles.brandMark}>Enter your code</Text>
            <Text style={styles.subtitle}>Check your email for the 6-digit code, then set a new password.</Text>
          </View>

          <View style={styles.form}>
            <Input
              testID="reset-password-email"
              label="Email"
              autoCapitalize="none"
              keyboardType="email-address"
              autoComplete="email"
              value={email}
              onChangeText={setEmail}
              placeholder="you@company.com"
            />
            <Input
              testID="reset-password-code"
              label="6-digit code"
              keyboardType="number-pad"
              maxLength={6}
              value={code}
              onChangeText={setCode}
              placeholder="123456"
            />
            <Input
              testID="reset-password-new"
              label="New password"
              secureTextEntry
              value={newPassword}
              onChangeText={setNewPassword}
              placeholder="••••••••"
            />
            <Input
              testID="reset-password-confirm"
              label="Confirm new password"
              secureTextEntry
              value={confirmPassword}
              onChangeText={setConfirmPassword}
              placeholder="••••••••"
            />
            {err ? <Text style={styles.err}>{err}</Text> : null}
            <Button testID="reset-password-submit" title="Reset password" loading={loading} onPress={onSubmit} />
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
