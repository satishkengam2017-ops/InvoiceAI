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

import { AddVendorModal } from "@/src/components/AddVendorModal";
import { Button } from "@/src/components/Button";
import { DateField } from "@/src/components/DateField";
import { Input } from "@/src/components/Input";
import { api } from "@/src/lib/api";
import { parseCents } from "@/src/lib/money";
import { colors, radius, spacing, typography } from "@/src/lib/theme";
import type { Expense, ExpenseCategory, Vendor } from "@/src/lib/types";

export type ExpensePrefill = {
  vendor_name?: string | null;
  date?: string | null;
  amount_cents?: number | null;
  tax_cents?: number | null;
  category_id?: string | null;
  description?: string | null;
};

function centsToInput(cents?: number | null): string {
  if (cents === null || cents === undefined) return "";
  return (cents / 100).toFixed(2);
}

export function AddExpenseModal({
  visible,
  expense,
  prefill,
  categories,
  vendors,
  onClose,
  onSaved,
  onVendorCreated,
}: {
  visible: boolean;
  expense?: Expense | null;
  prefill?: ExpensePrefill | null;
  categories: ExpenseCategory[];
  vendors: Vendor[];
  onClose: () => void;
  onSaved: (e: Expense) => void;
  onVendorCreated: (v: Vendor) => void;
}) {
  const [date, setDate] = useState("");
  const [amount, setAmount] = useState("");
  const [tax, setTax] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("");
  const [description, setDescription] = useState("");
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [vendorId, setVendorId] = useState<string | null>(null);
  const [detectedVendorName, setDetectedVendorName] = useState<string | null>(null);
  const [showPickCategory, setShowPickCategory] = useState(false);
  const [showPickVendor, setShowPickVendor] = useState(false);
  const [showAddVendor, setShowAddVendor] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const isEdit = !!expense;

  useEffect(() => {
    if (!visible) return;
    if (expense) {
      setDate(expense.date);
      setAmount(centsToInput(expense.amount_cents));
      setTax(centsToInput(expense.tax_cents));
      setPaymentMethod(expense.payment_method || "");
      setDescription(expense.description || "");
      setCategoryId(expense.category_id);
      setVendorId(expense.vendor_id || null);
      setDetectedVendorName(null);
    } else {
      setDate(prefill?.date || new Date().toISOString().slice(0, 10));
      setAmount(centsToInput(prefill?.amount_cents));
      setTax(centsToInput(prefill?.tax_cents));
      setPaymentMethod("");
      setDescription(prefill?.description || "");
      setCategoryId(prefill?.category_id || null);
      setVendorId(null);
      setDetectedVendorName(prefill?.vendor_name || null);
    }
    setErr(null);
  }, [visible, expense, prefill]);

  const reset = () => {
    setDate(""); setAmount(""); setTax(""); setPaymentMethod(""); setDescription("");
    setCategoryId(null); setVendorId(null); setDetectedVendorName(null); setErr(null);
  };

  const selectedCategory = categories.find((c) => c.id === categoryId);
  const selectedVendor = vendors.find((v) => v.id === vendorId);

  const onSave = async () => {
    if (!date) return setErr("Date is required");
    if (!categoryId) return setErr("Category is required");
    if (!amount || parseCents(amount) <= 0) return setErr("Amount must be greater than 0");
    setErr(null);
    setSaving(true);
    try {
      const payload = {
        vendor_id: vendorId,
        category_id: categoryId,
        date,
        amount_cents: parseCents(amount),
        tax_cents: parseCents(tax || "0"),
        payment_method: paymentMethod.trim() || null,
        description: description.trim() || null,
      };
      const e = isEdit
        ? await api.patch<Expense>(`/expenses/${expense!.id}`, payload)
        : await api.post<Expense>("/expenses", payload);
      if (!isEdit) reset();
      onSaved(e);
    } catch (err2) {
      setErr(err2 instanceof Error ? err2.message : "Failed to save");
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
              <Text style={styles.title}>{isEdit ? "Edit expense" : "Add expense"}</Text>
              <TouchableOpacity testID="add-expense-close" onPress={() => { reset(); onClose(); }}>
                <Feather name="x" size={22} color={colors.muted} />
              </TouchableOpacity>
            </View>
            <ScrollView keyboardShouldPersistTaps="handled" style={styles.scroll}>
              <DateField testID="add-expense-date" label="Date" value={date} onChange={setDate} />
              <Input testID="add-expense-amount" label="Amount *" keyboardType="decimal-pad" value={amount} onChangeText={setAmount} placeholder="0.00" />
              <Input testID="add-expense-tax" label="Tax" keyboardType="decimal-pad" value={tax} onChangeText={setTax} placeholder="0.00" />

              <Text style={styles.label}>Category *</Text>
              <TouchableOpacity testID="add-expense-pick-category" style={styles.picker} onPress={() => setShowPickCategory(true)}>
                <Text style={selectedCategory ? styles.pickerText : styles.pickerPlaceholder}>
                  {selectedCategory?.name || "Select a category"}
                </Text>
                <Feather name="chevron-right" size={18} color={colors.muted} />
              </TouchableOpacity>

              <Text style={styles.label}>Vendor</Text>
              {detectedVendorName && !vendorId ? (
                <Text style={styles.hint}>Detected on receipt: {detectedVendorName} — link a vendor below if you want to track it.</Text>
              ) : null}
              <TouchableOpacity testID="add-expense-pick-vendor" style={styles.picker} onPress={() => setShowPickVendor(true)}>
                <Text style={selectedVendor ? styles.pickerText : styles.pickerPlaceholder}>
                  {selectedVendor?.name || "No vendor (optional)"}
                </Text>
                <Feather name="chevron-right" size={18} color={colors.muted} />
              </TouchableOpacity>

              <Input testID="add-expense-payment-method" label="Payment method" value={paymentMethod} onChangeText={setPaymentMethod} placeholder="e.g. Visa, Cash, E-transfer" />
              <Input testID="add-expense-description" label="Description" value={description} onChangeText={setDescription} multiline />
            </ScrollView>
            {err ? <Text style={styles.err}>{err}</Text> : null}
            <Button testID="add-expense-save" title={isEdit ? "Save Changes" : "Save Expense"} loading={saving} onPress={onSave} />
          </View>
        </KeyboardAvoidingView>
      </View>

      <Modal visible={showPickCategory} animationType="slide" transparent onRequestClose={() => setShowPickCategory(false)}>
        <View style={styles.overlay}>
          <View style={styles.card}>
            <View style={styles.header}>
              <Text style={styles.title}>Select a category</Text>
              <TouchableOpacity testID="pick-category-close" onPress={() => setShowPickCategory(false)}>
                <Feather name="x" size={22} color={colors.muted} />
              </TouchableOpacity>
            </View>
            <ScrollView style={styles.scroll}>
              {categories.map((c) => (
                <TouchableOpacity
                  key={c.id}
                  testID={`pick-category-${c.id}`}
                  style={styles.pickRow}
                  onPress={() => { setCategoryId(c.id); setShowPickCategory(false); }}
                >
                  <Text style={styles.pickerText}>{c.name}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        </View>
      </Modal>

      <Modal visible={showPickVendor} animationType="slide" transparent onRequestClose={() => setShowPickVendor(false)}>
        <View style={styles.overlay}>
          <View style={styles.card}>
            <View style={styles.header}>
              <Text style={styles.title}>Select a vendor</Text>
              <TouchableOpacity testID="pick-vendor-close" onPress={() => setShowPickVendor(false)}>
                <Feather name="x" size={22} color={colors.muted} />
              </TouchableOpacity>
            </View>
            <ScrollView style={styles.scroll}>
              <TouchableOpacity
                testID="pick-vendor-none"
                style={styles.pickRow}
                onPress={() => { setVendorId(null); setShowPickVendor(false); }}
              >
                <Text style={styles.pickerText}>No vendor</Text>
              </TouchableOpacity>
              {vendors.length === 0 ? (
                <Text style={styles.hint}>No vendors yet.</Text>
              ) : (
                vendors.map((v) => (
                  <TouchableOpacity
                    key={v.id}
                    testID={`pick-vendor-${v.id}`}
                    style={styles.pickRow}
                    onPress={() => { setVendorId(v.id); setShowPickVendor(false); }}
                  >
                    <Text style={styles.pickerText}>{v.name}</Text>
                  </TouchableOpacity>
                ))
              )}
            </ScrollView>
            <Button
              testID="pick-vendor-new"
              title="+ Add new vendor"
              variant="secondary"
              onPress={() => { setShowPickVendor(false); setShowAddVendor(true); }}
            />
          </View>
        </View>
      </Modal>

      <AddVendorModal
        visible={showAddVendor}
        onClose={() => setShowAddVendor(false)}
        onSaved={(v) => {
          onVendorCreated(v);
          setVendorId(v.id);
          setShowAddVendor(false);
        }}
      />
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
  label: {
    fontSize: typography.sm,
    color: colors.onSurfaceTertiary,
    marginBottom: spacing.xs,
    fontWeight: typography.weightMedium,
  },
  hint: { fontSize: typography.sm, color: colors.muted, marginBottom: spacing.xs },
  picker: {
    minHeight: 48,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.lg,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: spacing.md,
  },
  pickerText: { fontSize: typography.lg, color: colors.onSurface },
  pickerPlaceholder: { fontSize: typography.lg, color: colors.muted },
  pickRow: {
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
});
