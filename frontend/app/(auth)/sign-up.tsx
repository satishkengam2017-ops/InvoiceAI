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
import { GoogleSignInButton } from "@/src/components/GoogleSignInButton";
import { Input } from "@/src/components/Input";
import { useAuth } from "@/src/context/AuthContext";
import { colors, spacing, typography, webContent } from "@/src/lib/theme";

export default function SignUp() {
  const { signUp, loading } = useAuth();
  const [businessName, setBusinessName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const onSubmit = async () => {
    setErr(null);
    if (password.length < 6) return setErr("Password must be at least 6 characters");
    if (!businessName.trim()) return setErr("Business name is required");
    try {
      await signUp(email.trim().toLowerCase(), password, businessName.trim());
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Sign-up failed");
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={[styles.scroll, webContent]} keyboardShouldPersistTaps="handled">
          <View style={styles.brand}>
            <Text style={styles.brandMark}>Create account</Text>
            <Text style={styles.subtitle}>Start invoicing in under a minute.</Text>
          </View>

          <View>
            <Input
              testID="sign-up-business-name"
              label="Business name"
              value={businessName}
              onChangeText={setBusinessName}
              placeholder="Acme Electrical"
            />
            <Input
              testID="sign-up-email"
              label="Email"
              autoCapitalize="none"
              keyboardType="email-address"
              autoComplete="email"
              value={email}
              onChangeText={setEmail}
              placeholder="you@company.com"
            />
            <Input
              testID="sign-up-password"
              label="Password"
              secureTextEntry
              value={password}
              onChangeText={setPassword}
              placeholder="At least 6 characters"
            />
            {err ? <Text style={styles.err}>{err}</Text> : null}
            <Button testID="sign-up-submit" title="Create Account" loading={loading} onPress={onSubmit} />
            <GoogleSignInButton onError={setErr} />

            <Link href="/(auth)/sign-in" asChild>
              <Text testID="sign-up-link-signin" style={styles.link}>Have an account? Sign in</Text>
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
    fontSize: 32,
    fontWeight: "600",
    color: colors.onSurface,
    letterSpacing: -0.5,
  },
  subtitle: {
    fontSize: typography.lg,
    color: colors.muted,
    marginTop: spacing.sm,
  },
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
