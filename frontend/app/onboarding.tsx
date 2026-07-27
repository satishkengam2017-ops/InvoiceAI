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
import { api } from "@/src/lib/api";
import { colors, spacing, typography, webContent } from "@/src/lib/theme";
import type { Business } from "@/src/lib/types";

export default function Onboarding() {
  const { business, refreshBusiness } = useAuth();
  const [name, setName] = useState(business?.name || "");
  const [email, setEmail] = useState(business?.email || "");
  const [phone, setPhone] = useState(business?.phone || "");
  const [address, setAddress] = useState(business?.address_line1 || "");
  const [city, setCity] = useState(business?.city || "");
  const [region, setRegion] = useState(business?.region || "");
  const [country, setCountry] = useState(business?.country || "");
  const [gstHstNumber, setGstHstNumber] = useState(business?.gst_hst_number || "");
  const [currency, setCurrency] = useState(business?.currency || "USD");
  const [dueDays, setDueDays] = useState(String(business?.default_due_days ?? 14));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const onSave = async () => {
    setErr(null);
    setSaving(true);
    try {
      await api.patch<Business>("/business/me", {
        name: name.trim(),
        email: email.trim(),
        phone: phone.trim() || null,
        address_line1: address.trim() || null,
        city: city.trim() || null,
        region: region.trim() || null,
        country: country.trim() || null,
        gst_hst_number: gstHstNumber.trim() || null,
        currency: currency.trim().toUpperCase() || "USD",
        default_due_days: parseInt(dueDays, 10) || 14,
        onboarded: true,
      });
      await refreshBusiness();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={[styles.scroll, webContent]} keyboardShouldPersistTaps="handled">
          <View style={styles.header}>
            <Text style={styles.step}>Step 1 of 1</Text>
            <Text style={styles.title}>Tell us about your business</Text>
            <Text style={styles.subtitle}>This appears on every invoice you send.</Text>
          </View>

          <View style={styles.form}>
            <Input testID="onboard-name" label="Business name" value={name} onChangeText={setName} />
            <Input testID="onboard-email" label="Contact email" keyboardType="email-address" autoCapitalize="none" value={email} onChangeText={setEmail} />
            <Input testID="onboard-phone" label="Phone (optional)" keyboardType="phone-pad" value={phone} onChangeText={setPhone} />
            <Input testID="onboard-address" label="Address line 1 (optional)" value={address} onChangeText={setAddress} />
            <View style={{ flexDirection: "row", gap: spacing.md }}>
              <View style={{ flex: 1 }}>
                <Input testID="onboard-city" label="City (optional)" value={city} onChangeText={setCity} />
              </View>
              <View style={{ flex: 1 }}>
                <Input testID="onboard-region" label="Province/State (optional)" value={region} onChangeText={setRegion} />
              </View>
            </View>
            <Input testID="onboard-country" label="Country (optional)" value={country} onChangeText={setCountry} />
            <Input testID="onboard-gst-hst" label="GST/HST Registration No. (optional)" value={gstHstNumber} onChangeText={setGstHstNumber} />
            <View style={{ flexDirection: "row", gap: spacing.md }}>
              <View style={{ flex: 1 }}>
                <Input testID="onboard-currency" label="Currency" autoCapitalize="characters" value={currency} onChangeText={setCurrency} />
              </View>
              <View style={{ flex: 1 }}>
                <Input testID="onboard-due-days" label="Default due days" keyboardType="number-pad" value={dueDays} onChangeText={setDueDays} />
              </View>
            </View>

            {err ? <Text style={styles.err}>{err}</Text> : null}
            <Button testID="onboard-save" title="Save & Continue" loading={saving} onPress={onSave} />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.surface },
  scroll: { flexGrow: 1, padding: spacing.xl },
  header: { marginBottom: spacing.xl, marginTop: spacing.lg },
  step: {
    fontSize: typography.sm,
    color: colors.brand,
    fontWeight: "500",
    marginBottom: spacing.sm,
  },
  title: {
    fontSize: 28,
    fontWeight: "600",
    color: colors.onSurface,
    letterSpacing: -0.5,
  },
  subtitle: {
    fontSize: typography.lg,
    color: colors.muted,
    marginTop: spacing.sm,
  },
  form: {},
  err: {
    color: colors.error,
    marginBottom: spacing.md,
    fontSize: typography.base,
  },
});
