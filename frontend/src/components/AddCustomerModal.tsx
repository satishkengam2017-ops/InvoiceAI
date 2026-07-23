import { Feather } from "@expo/vector-icons";
import React, { useState } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
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
  onClose,
  onCreated,
}: {
  visible: boolean;
  onClose: () => void;
  onCreated: (c: Customer) => void;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [company, setCompany] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const reset = () => {
    setName(""); setEmail(""); setPhone(""); setCompany(""); setErr(null);
  };

  const onSave = async () => {
    if (!name.trim()) return setErr("Name is required");
    setErr(null);
    setSaving(true);
    try {
      const c = await api.post<Customer>("/customers", {
        name: name.trim(),
        email: email.trim() || null,
        phone: phone.trim() || null,
        company: company.trim() || null,
      });
      reset();
      onCreated(c);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to create");
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
              <Text style={styles.title}>Add customer</Text>
              <TouchableOpacity testID="add-customer-close" onPress={() => { reset(); onClose(); }}>
                <Feather name="x" size={22} color={colors.muted} />
              </TouchableOpacity>
            </View>
            <Input testID="add-customer-name" label="Name *" value={name} onChangeText={setName} />
            <Input testID="add-customer-email" label="Email" keyboardType="email-address" autoCapitalize="none" value={email} onChangeText={setEmail} />
            <Input testID="add-customer-phone" label="Phone" keyboardType="phone-pad" value={phone} onChangeText={setPhone} />
            <Input testID="add-customer-company" label="Company" value={company} onChangeText={setCompany} />
            {err ? <Text style={styles.err}>{err}</Text> : null}
            <Button testID="add-customer-save" title="Save Customer" loading={saving} onPress={onSave} />
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
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: spacing.lg,
  },
  title: { fontSize: 20, fontWeight: "600", color: colors.onSurface },
  err: { color: colors.error, marginBottom: spacing.sm, fontSize: 14 },
});
