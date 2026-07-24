import { Link } from "expo-router";
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
import { useAuth } from "@/src/context/AuthContext";
import { colors, spacing, typography, webContent } from "@/src/lib/theme";

export default function SignIn() {
  const { signIn, loading } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const onSubmit = async () => {
    setErr(null);
    try {
      await signIn(email.trim().toLowerCase(), password);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Sign-in failed");
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={[styles.scroll, webContent]} keyboardShouldPersistTaps="handled">
          <View style={styles.brand}>
            <Text style={styles.brandMark}>Invoice<Text style={{ color: colors.brand }}>AI</Text></Text>
            <Text style={styles.subtitle}>Get paid faster. Draft a professional invoice in 30 seconds.</Text>
          </View>

          <View style={styles.form}>
            <Input
              testID="sign-in-email"
              label="Email"
              autoCapitalize="none"
              keyboardType="email-address"
              autoComplete="email"
              value={email}
              onChangeText={setEmail}
              placeholder="you@company.com"
            />
            <Input
              testID="sign-in-password"
              label="Password"
              secureTextEntry
              value={password}
              onChangeText={setPassword}
              placeholder="••••••••"
            />
            {err ? <Text style={styles.err}>{err}</Text> : null}
            <Button testID="sign-in-submit" title="Sign In" loading={loading} onPress={onSubmit} />

            <Link href="/(auth)/sign-up" asChild>
              <Text testID="sign-in-link-signup" style={styles.link}>
                New here? Create an account
              </Text>
            </Link>
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
    fontSize: 40,
    fontWeight: "600",
    color: colors.onSurface,
    letterSpacing: -1,
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
  link: {
    textAlign: "center",
    color: colors.brand,
    marginTop: spacing.xl,
    fontSize: typography.base,
    fontWeight: "500",
  },
});
