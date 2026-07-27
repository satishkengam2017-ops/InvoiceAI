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
import type { Customer } from "@/src/lib/types";

export function AddCustomerModal({
  visible,
  customer,
  onClose,
  onSaved,
}: {
  visible: boolean;
  /** When provided, the modal edits this customer instead of creating a new one. */
  customer?: Customer | null;
  onClose: () => void;
  onSaved: (c: Customer) => void;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [company, setCompany] = useState("");
  const [addressLine1, setAddressLine1] = useState("");
  const [city, setCity] = useState("");
  const [region, setRegion] = useState("");
  const [postalCode, setPostalCode] = useState("");
  const [country, setCountry] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const isEdit = !!customer;

  useEffect(() => {
    if (!visible) return;
    setName(customer?.name || "");
    setEmail(customer?.email || "");
    setPhone(customer?.phone || "");
    setCompany(customer?.company || "");
    setAddressLine1(customer?.address_line1 || "");
    setCity(customer?.city || "");
    setRegion(customer?.region || "");
    setPostalCode(customer?.postal_code || "");
    setCountry(customer?.country || "");
    setErr(null);
  }, [visible, customer]);

  const reset = () => {
    setName(""); setEmail(""); setPhone(""); setCompany("");
    setAddressLine1(""); setCity(""); setRegion(""); setPostalCode(""); setCountry("");
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
        company: company.trim() || null,
        address_line1: addressLine1.trim() || null,
        city: city.trim() || null,
        region: region.trim() || null,
        postal_code: postalCode.trim() || null,
        country: country.trim() || null,
      };
      const c = isEdit
        ? await api.patch<Customer>(`/customers/${customer!.id}`, payload)
        : await api.post<Customer>("/customers", payload);
      if (!isEdit) reset();
      onSaved(c);
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
              <Text style={styles.title}>{isEdit ? "Edit customer" : "Add customer"}</Text>
              <TouchableOpacity testID="add-customer-close" onPress={() => { reset(); onClose(); }}>
                <Feather name="x" size={22} color={colors.muted} />
              </TouchableOpacity>
            </View>
            <ScrollView keyboardShouldPersistTaps="handled" style={styles.scroll}>
              <Input testID="add-customer-name" label="Name *" value={name} onChangeText={setName} />
              <Input testID="add-customer-email" label="Email" keyboardType="email-address" autoCapitalize="none" value={email} onChangeText={setEmail} />
              <Input testID="add-customer-phone" label="Phone" keyboardType="phone-pad" value={phone} onChangeText={setPhone} />
              <Input testID="add-customer-company" label="Company" value={company} onChangeText={setCompany} />
              <Input testID="add-customer-address" label="Address" value={addressLine1} onChangeText={setAddressLine1} />
              <View style={{ flexDirection: "row", gap: spacing.md }}>
                <View style={{ flex: 1 }}>
                  <Input testID="add-customer-city" label="City" value={city} onChangeText={setCity} />
                </View>
                <View style={{ flex: 1 }}>
                  <Input testID="add-customer-region" label="Province/State" value={region} onChangeText={setRegion} />
                </View>
              </View>
              <View style={{ flexDirection: "row", gap: spacing.md }}>
                <View style={{ flex: 1 }}>
                  <Input testID="add-customer-postal-code" label="Postal/ZIP code" value={postalCode} onChangeText={setPostalCode} />
                </View>
                <View style={{ flex: 1 }}>
                  <Input testID="add-customer-country" label="Country" value={country} onChangeText={setCountry} />
                </View>
              </View>
            </ScrollView>
            {err ? <Text style={styles.err}>{err}</Text> : null}
            <Button testID="add-customer-save" title={isEdit ? "Save Changes" : "Save Customer"} loading={saving} onPress={onSave} />
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
