import { Feather } from "@expo/vector-icons";
import React, { useEffect, useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Button } from "@/src/components/Button";
import { Card } from "@/src/components/Card";
import { Input } from "@/src/components/Input";
import { useAuth } from "@/src/context/AuthContext";
import { api } from "@/src/lib/api";
import { colors, radius, spacing, typography } from "@/src/lib/theme";
import type { Business, DashboardSummary, Plan } from "@/src/lib/types";

const PLANS: { key: Plan; label: string; price: string; desc: string }[] = [
  { key: "FREE", label: "Free", price: "$0", desc: "5 invoices lifetime" },
  { key: "STARTER", label: "Starter", price: "$1/mo", desc: "10 invoices per month" },
  { key: "PRO", label: "Pro", price: "$5/mo", desc: "50 invoices per month" },
];

export default function Settings() {
  const { business, refreshBusiness, signOut, user } = useAuth();
  const [name, setName] = useState(business?.name || "");
  const [email, setEmail] = useState(business?.email || "");
  const [currency, setCurrency] = useState(business?.currency || "USD");
  const [defaultTerms, setDefaultTerms] = useState(business?.default_terms || "");
  const [stripeUrl, setStripeUrl] = useState(business?.stripe_payment_url_default || "");
  const [anthropicKey, setAnthropicKey] = useState("");
  const [plan, setPlan] = useState<Plan>(business?.plan || "FREE");
  const [saving, setSaving] = useState(false);
  const [savingKey, setSavingKey] = useState(false);
  const [savingPlan, setSavingPlan] = useState(false);
  const [usage, setUsage] = useState<DashboardSummary["plan_usage"] | null>(null);

  useEffect(() => {
    if (business) {
      setName(business.name);
      setEmail(business.email || "");
      setCurrency(business.currency);
      setDefaultTerms(business.default_terms || "");
      setStripeUrl(business.stripe_payment_url_default || "");
      setPlan(business.plan);
    }
  }, [business]);

  useEffect(() => {
    api.get<DashboardSummary>("/dashboard/summary")
      .then((s) => setUsage(s.plan_usage))
      .catch(() => {});
  }, [business]);

  const saveProfile = async () => {
    setSaving(true);
    try {
      await api.patch<Business>("/business/me", {
        name: name.trim(),
        email: email.trim(),
        currency: currency.trim().toUpperCase(),
        default_terms: defaultTerms.trim() || null,
      });
      await refreshBusiness();
      Alert.alert("Saved", "Business profile updated.");
    } catch (e) {
      Alert.alert("Error", e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const saveAnthropicKey = async () => {
    if (!anthropicKey.trim()) return;
    setSavingKey(true);
    try {
      await api.patch("/settings", { anthropic_api_key: anthropicKey.trim() });
      setAnthropicKey("");
      await refreshBusiness();
      Alert.alert("Saved", "Anthropic API key saved.");
    } catch (e) {
      Alert.alert("Error", e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSavingKey(false);
    }
  };

  const saveStripe = async () => {
    setSaving(true);
    try {
      await api.patch("/settings", { stripe_payment_url_default: stripeUrl.trim() || null });
      await refreshBusiness();
    } catch (e) {
      Alert.alert("Error", e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const switchPlan = async (newPlan: Plan) => {
    if (newPlan === plan) return;
    setSavingPlan(true);
    try {
      await api.patch("/settings", { plan: newPlan });
      setPlan(newPlan);
      await refreshBusiness();
    } catch (e) {
      Alert.alert("Error", e instanceof Error ? e.message : "Failed to change plan");
    } finally {
      setSavingPlan(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <Text style={styles.title}>Settings</Text>

          {/* Business Profile */}
          <Card style={styles.card}>
            <Text style={styles.sectionTitle}>Business Profile</Text>
            <Input testID="settings-name" label="Business name" value={name} onChangeText={setName} />
            <Input testID="settings-email" label="Contact email" keyboardType="email-address" autoCapitalize="none" value={email} onChangeText={setEmail} />
            <View style={{ flexDirection: "row", gap: spacing.md }}>
              <View style={{ flex: 1 }}>
                <Input testID="settings-currency" label="Currency" autoCapitalize="characters" value={currency} onChangeText={setCurrency} />
              </View>
            </View>
            <Input testID="settings-terms" label="Default terms" value={defaultTerms} onChangeText={setDefaultTerms} multiline />
            <Button testID="settings-save-profile" title="Save Profile" loading={saving} onPress={saveProfile} />
          </Card>

          {/* Anthropic API Key */}
          <Card style={styles.card}>
            <View style={styles.sectionRow}>
              <Text style={styles.sectionTitle}>AI Extraction</Text>
              {business?.has_anthropic_key ? (
                <View style={styles.badge}>
                  <Feather name="check" size={12} color={colors.brand} />
                  <Text style={styles.badgeText}>Configured</Text>
                </View>
              ) : (
                <View style={[styles.badge, { backgroundColor: "#FEF3C7" }]}>
                  <Text style={[styles.badgeText, { color: "#92400E" }]}>Not set</Text>
                </View>
              )}
            </View>
            <Text style={styles.help}>
              Provide your Anthropic API key to use the AI &quot;Describe the job&quot; feature. Get one at console.anthropic.com.
            </Text>
            <Input
              testID="settings-anthropic-key"
              label="Anthropic API key"
              secureTextEntry
              autoCapitalize="none"
              placeholder="sk-ant-..."
              value={anthropicKey}
              onChangeText={setAnthropicKey}
            />
            <Button
              testID="settings-save-anthropic"
              title={business?.has_anthropic_key ? "Update Key" : "Save Key"}
              loading={savingKey}
              onPress={saveAnthropicKey}
              disabled={!anthropicKey.trim()}
            />
          </Card>

          {/* Stripe URL */}
          <Card style={styles.card}>
            <Text style={styles.sectionTitle}>Default Stripe Payment URL</Text>
            <Text style={styles.help}>
              Paste a Stripe payment link (or any hosted payment URL). It appears on every new invoice; you can override per invoice.
            </Text>
            <Input
              testID="settings-stripe-url"
              label="Payment URL"
              autoCapitalize="none"
              keyboardType="url"
              placeholder="https://buy.stripe.com/..."
              value={stripeUrl}
              onChangeText={setStripeUrl}
            />
            <Button testID="settings-save-stripe" title="Save URL" onPress={saveStripe} loading={saving} />
          </Card>

          {/* Plan */}
          <Card style={styles.card}>
            <Text style={styles.sectionTitle}>Subscription plan</Text>
            {usage ? (
              <View style={styles.usageBox}>
                <Text style={styles.usageText}>
                  {usage.used} / {usage.limit} invoices used this {usage.scope}
                </Text>
                <View style={styles.progressBar}>
                  <View style={[styles.progressFill, { width: `${Math.min(100, (usage.used / usage.limit) * 100)}%` }]} />
                </View>
              </View>
            ) : null}
            {PLANS.map((p) => {
              const active = p.key === plan;
              return (
                <TouchableOpacity
                  key={p.key}
                  testID={`plan-${p.key.toLowerCase()}`}
                  style={[styles.planRow, active && styles.planRowActive]}
                  onPress={() => switchPlan(p.key)}
                  activeOpacity={0.85}
                  disabled={savingPlan}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={styles.planLabel}>{p.label}</Text>
                    <Text style={styles.planDesc}>{p.desc}</Text>
                  </View>
                  <Text style={styles.planPrice}>{p.price}</Text>
                  {active ? (
                    <View style={styles.planCheck}>
                      <Feather name="check" size={16} color={colors.brand} />
                    </View>
                  ) : null}
                </TouchableOpacity>
              );
            })}
            <Text style={styles.help}>Plan changes take effect immediately. Payment collection can be enabled by pasting your own Stripe subscription link above.</Text>
          </Card>

          {/* Account */}
          <Card style={styles.card}>
            <Text style={styles.sectionTitle}>Account</Text>
            <Text style={styles.help}>Signed in as {user?.email}</Text>
            <Button testID="settings-sign-out" title="Sign Out" variant="secondary" onPress={signOut} />
          </Card>

          <View style={{ height: 100 }} />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.surface },
  scroll: { padding: spacing.lg },
  title: {
    fontSize: 28,
    fontWeight: "600",
    color: colors.onSurface,
    letterSpacing: -0.5,
    marginBottom: spacing.lg,
    marginTop: spacing.sm,
  },
  card: { marginBottom: spacing.md },
  sectionRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  sectionTitle: {
    fontSize: typography.lg,
    fontWeight: "500",
    color: colors.onSurface,
    marginBottom: spacing.md,
  },
  help: { fontSize: typography.sm, color: colors.muted, marginBottom: spacing.md, lineHeight: 18 },
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: colors.brandTertiary,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.pill,
    marginBottom: spacing.md,
  },
  badgeText: { fontSize: 11, fontWeight: "500", color: colors.brand },
  usageBox: {
    padding: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    marginBottom: spacing.md,
  },
  usageText: { fontSize: typography.base, color: colors.onSurface, marginBottom: spacing.sm },
  progressBar: { height: 6, backgroundColor: colors.surfaceTertiary, borderRadius: 3, overflow: "hidden" },
  progressFill: { height: 6, backgroundColor: colors.brand, borderRadius: 3 },
  planRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: spacing.sm,
    backgroundColor: colors.surface,
  },
  planRowActive: { borderColor: colors.brand, backgroundColor: colors.brandTertiary },
  planLabel: { fontSize: typography.lg, fontWeight: "500", color: colors.onSurface },
  planDesc: { fontSize: typography.sm, color: colors.muted, marginTop: 2 },
  planPrice: { fontSize: typography.lg, fontWeight: "500", color: colors.onSurface },
  planCheck: {
    width: 24, height: 24, borderRadius: 12,
    backgroundColor: colors.brandTertiary, alignItems: "center", justifyContent: "center",
  },
});
