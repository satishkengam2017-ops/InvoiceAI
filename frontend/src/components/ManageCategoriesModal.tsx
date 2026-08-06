import { Feather } from "@expo/vector-icons";
import React, { useState } from "react";
import { Alert, Modal, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";

import { Button } from "@/src/components/Button";
import { api } from "@/src/lib/api";
import { confirmAsync } from "@/src/lib/confirm";
import { colors, radius, spacing, typography } from "@/src/lib/theme";
import type { ExpenseCategory } from "@/src/lib/types";

export function ManageCategoriesModal({
  visible,
  categories,
  onClose,
  onChanged,
}: {
  visible: boolean;
  categories: ExpenseCategory[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [newName, setNewName] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const addCategory = async () => {
    if (!newName.trim()) return;
    setSaving(true);
    setErr(null);
    try {
      await api.post("/expense-categories", { name: newName.trim() });
      setNewName("");
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to add category");
    } finally {
      setSaving(false);
    }
  };

  const removeCategory = async (category: ExpenseCategory) => {
    const ok = await confirmAsync("Remove category?", `"${category.name}" will no longer appear when logging expenses.`);
    if (!ok) return;
    try {
      await api.del(`/expense-categories/${category.id}`);
      onChanged();
    } catch (e) {
      Alert.alert("Can't remove category", e instanceof Error ? e.message : "This category is used by existing expenses.");
    }
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          <View style={styles.header}>
            <Text style={styles.title}>Expense categories</Text>
            <TouchableOpacity testID="manage-categories-close" onPress={onClose}>
              <Feather name="x" size={22} color={colors.muted} />
            </TouchableOpacity>
          </View>
          <ScrollView style={styles.scroll}>
            {categories.map((c) => (
              <View key={c.id} style={styles.row}>
                <Text style={styles.rowText}>{c.name}</Text>
                <TouchableOpacity testID={`manage-categories-delete-${c.id}`} onPress={() => removeCategory(c)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <Feather name="trash-2" size={18} color={colors.error} />
                </TouchableOpacity>
              </View>
            ))}
          </ScrollView>
          <View style={styles.addRow}>
            <TextInput
              testID="manage-categories-new-name"
              placeholder="New category name"
              placeholderTextColor={colors.muted}
              style={styles.input}
              value={newName}
              onChangeText={setNewName}
            />
            <Button testID="manage-categories-add" title="Add" loading={saving} onPress={addCategory} />
          </View>
          {err ? <Text style={styles.err}>{err}</Text> : null}
        </View>
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
  scroll: { flexGrow: 0, maxHeight: 320 },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: spacing.lg,
  },
  title: { fontSize: 20, fontWeight: "600", color: colors.onSurface },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  rowText: { fontSize: typography.lg, color: colors.onSurface },
  addRow: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.md, alignItems: "center" },
  input: {
    flex: 1,
    minHeight: 48,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.lg,
    fontSize: typography.lg,
    color: colors.onSurface,
  },
  err: { color: colors.error, marginTop: spacing.sm, fontSize: 14 },
});
