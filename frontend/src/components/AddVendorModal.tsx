import { Feather } from "@expo/vector-icons";
import React, { useEffect, useState } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

import { Button } from "@/src/components/Button";
import { Input } from "@/src/components/Input";
import { api } from "@/src/lib/api";
import { colors, radius, spacing } from "@/src/lib/theme";
import type { Vendor } from "@/src/lib/types";

export function AddVendorModal({
  visible,
  vendor,
  onClose,
  onSaved,
}: {
  visible: boolean;
  vendor?: Vendor | null;
  onClose: () => void;
  onSaved: (v: Vendor) => void;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [addressLine1, setAddressLine1] = useState("");
  const [city, setCity] = useState("");
  const [region, setRegion] = useState("");
  const [postalCode, setPostalCode] = useState("");
  const [country, setCountry] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const isEdit = !!vendor;

  useEffect(() => {
    if (!visible) return;
    setName(vendor?.name || "");
    setEmail(vendor?.email || "");
    setPhone(vendor?.phone || "");
    setAddressLine1(vendor?.address_line1 || "");
    setCity(vendor?.city || "");
    setRegion(vendor?.region || "");
    setPostalCode(vendor?.postal_code || "");
    setCountry(vendor?.country || "");
    setNotes(vendor?.notes || "");
    setErr(null);
  }, [visible, vendor]);

  const reset = () => {
    setName(""); setEmail(""); setPhone("");
    setAddressLine1(""); setCity(""); setRegion(""); setPostalCode(""); setCountry(""); setNotes("");
    setErr(null);
  };

  const onSave = async () => {
    if (!name.trim()) return setErr("Name is required");
    setErr(null);
    setSaving(true);
    try {
      const payload = {
        name: name.trim(),
        email: email.trim() || null,
        phone: phone.trim() || null,
        address_line1: addressLine1.trim() || null,
        city: city.trim() || null,
        region: region.trim() || null,
        postal_code: postalCode.trim() || null,
        country: country.trim() || null,
        notes: notes.trim() || null,
      };
      const v = isEdit
        ? await api.patch<Vendor>(`/vendors/${vendor!.id}`, payload)
        : await api.post<Vendor>("/vendors", payload);
      if (!isEdit) reset();
      onSaved(v);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined}>
          <View style={styles.card}>
            <View style={styles.header}>
              <Text style={styles.title}>{isEdit ? "Edit vendor" : "Add vendor"}</Text>
              <TouchableOpacity testID="add-vendor-close" onPress={() => { reset(); onClose(); }}>
                <Feather name="x" size={22} color={colors.muted} />
              </TouchableOpacity>
            </View>
            <ScrollView keyboardShouldPersistTaps="handled" style={styles.scroll}>
              <Input testID="add-vendor-name" label="Name *" value={name} onChangeText={setName} />
              <Input testID="add-vendor-email" label="Email" keyboardType="email-address" autoCapitalize="none" value={email} onChangeText={setEmail} />
              <Input testID="add-vendor-phone" label="Phone" keyboardType="phone-pad" value={phone} onChangeText={setPhone} />
              <Input testID="add-vendor-address" label="Address" value={addressLine1} onChangeText={setAddressLine1} />
              <View style={{ flexDirection: "row", gap: spacing.md }}>
                <View style={{ flex: 1 }}>
                  <Input testID="add-vendor-city" label="City" value={city} onChangeText={setCity} />
                </View>
                <View style={{ flex: 1 }}>
                  <Input testID="add-vendor-region" label="Province/State" value={region} onChangeText={setRegion} />
                </View>
              </View>
              <View style={{ flexDirection: "row", gap: spacing.md }}>
                <View style={{ flex: 1 }}>
                  <Input testID="add-vendor-postal-code" label="Postal/ZIP code" value={postalCode} onChangeText={setPostalCode} />
                </View>
                <View style={{ flex: 1 }}>
                  <Input testID="add-vendor-country" label="Country" value={country} onChangeText={setCountry} />
                </View>
              </View>
              <Input testID="add-vendor-notes" label="Notes" value={notes} onChangeText={setNotes} multiline />
            </ScrollView>
            {err ? <Text style={styles.err}>{err}</Text> : null}
            <Button testID="add-vendor-save" title={isEdit ? "Save Changes" : "Save Vendor"} loading={saving} onPress={onSave} />
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" },
  card: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    padding: spacing.lg,
    paddingBottom: spacing.xxxl,
    maxHeight: "85%",
  },
  scroll: { flexGrow: 0 },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: spacing.lg,
  },
  title: { fontSize: 20, fontWeight: "600", color: colors.onSurface },
  err: { color: colors.error, marginBottom: spacing.sm, fontSize: 14 },
});
