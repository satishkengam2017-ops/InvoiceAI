import { Feather } from "@expo/vector-icons";
import { useFocusEffect, useRouter } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import React, { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Platform,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AddExpenseModal } from "@/src/components/AddExpenseModal";
import type { ExpensePrefill } from "@/src/components/AddExpenseModal";
import { Button } from "@/src/components/Button";
import { EmptyState } from "@/src/components/Card";
import { ManageCategoriesModal } from "@/src/components/ManageCategoriesModal";
import { api, scanReceipt } from "@/src/lib/api";
import { confirmAsync } from "@/src/lib/confirm";
import { formatMoney } from "@/src/lib/money";
import { colors, radius, spacing, typography, webContent } from "@/src/lib/theme";
import type { Expense, ExpenseCategory, Vendor } from "@/src/lib/types";

export default function Expenses() {
  const router = useRouter();
  const [items, setItems] = useState<Expense[]>([]);
  const [categories, setCategories] = useState<ExpenseCategory[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [editing, setEditing] = useState<Expense | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [showManageCategories, setShowManageCategories] = useState(false);
  const [prefill, setPrefill] = useState<ExpensePrefill | null>(null);
  const [scanning, setScanning] = useState(false);

  const load = useCallback(async () => {
    try {
      const [exp, cats, vends] = await Promise.all([
        api.get<Expense[]>("/expenses"),
        api.get<ExpenseCategory[]>("/expense-categories"),
        api.get<Vendor[]>("/vendors"),
      ]);
      setItems(exp);
      setCategories(cats);
      setVendors(vends);
    } catch {
      /* ignore — AuthContext redirects if the session is invalid */
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const categoryName = (id: string) => categories.find((c) => c.id === id)?.name || "Uncategorized";
  const vendorName = (id?: string | null) => (id ? vendors.find((v) => v.id === id)?.name : null);

  const deleteExpense = async (expense: Expense) => {
    const ok = await confirmAsync("Delete expense?", "This can't be undone.");
    if (!ok) return;
    try {
      await api.del(`/expenses/${expense.id}`);
      setItems((prev) => prev.filter((e) => e.id !== expense.id));
    } catch (e) {
      Alert.alert("Delete failed", e instanceof Error ? e.message : "Unknown error");
    }
  };

  const scanReceiptPhoto = async () => {
    let result: ImagePicker.ImagePickerResult;
    if (Platform.OS === "web") {
      result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 0.7 });
    } else {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) {
        Alert.alert("Camera access needed", "Enable camera access in your device settings to scan receipts.");
        return;
      }
      result = await ImagePicker.launchCameraAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 0.7 });
    }
    if (result.canceled || !result.assets?.[0]) return;

    const asset = result.assets[0];
    setScanning(true);
    try {
      const extracted = await scanReceipt(asset.uri, asset.fileName || "receipt.jpg", asset.mimeType || "image/jpeg");
      setPrefill(extracted);
    } catch {
      setPrefill(null);
      Alert.alert("Couldn't read that receipt", "Enter the expense manually instead.");
    } finally {
      setScanning(false);
      setEditing(null);
      setShowAdd(true);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={[styles.header, webContent]}>
        <Text style={styles.title}>Expenses</Text>
        <View style={styles.headerActions}>
          <TouchableOpacity testID="expenses-manage-categories" onPress={() => setShowManageCategories(true)} style={styles.iconBtn}>
            <Feather name="tag" size={18} color={colors.brand} />
          </TouchableOpacity>
          <TouchableOpacity testID="expenses-goto-vendors" onPress={() => router.push("/vendors")} style={styles.iconBtn}>
            <Feather name="briefcase" size={18} color={colors.brand} />
          </TouchableOpacity>
          <TouchableOpacity testID="expenses-scan-btn" onPress={scanReceiptPhoto} style={styles.iconBtn} disabled={scanning}>
            {scanning ? <ActivityIndicator size="small" color={colors.brand} /> : <Feather name="camera" size={18} color={colors.brand} />}
          </TouchableOpacity>
          <TouchableOpacity testID="expenses-add-btn" onPress={() => { setEditing(null); setShowAdd(true); }} style={styles.newBtn}>
            <Feather name="plus" size={16} color={colors.onBrandPrimary} />
            <Text style={styles.newBtnText}>Add</Text>
          </TouchableOpacity>
        </View>
      </View>

      {loading ? (
        <ActivityIndicator style={{ marginTop: 40 }} size="large" color={colors.brand} />
      ) : items.length === 0 ? (
        <EmptyState
          testID="expenses-empty"
          title="No expenses yet"
          subtitle="Log your first expense manually or scan a receipt."
          action={<Button testID="expenses-empty-add" title="Add Expense" onPress={() => { setEditing(null); setShowAdd(true); }} />}
        />
      ) : (
        <FlatList
          data={items}
          keyExtractor={(i) => i.id}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={colors.brand} />}
          contentContainerStyle={[styles.list, webContent]}
          renderItem={({ item }) => (
            <TouchableOpacity
              testID={`expense-row-${item.id}`}
              style={styles.row}
              onPress={() => { setEditing(item); setShowAdd(true); }}
              activeOpacity={0.85}
            >
              <View style={{ flex: 1 }}>
                <Text style={styles.rowName}>{categoryName(item.category_id)}</Text>
                <Text style={styles.rowSub}>{vendorName(item.vendor_id) || item.description || item.date}</Text>
              </View>
              <Text style={styles.rowAmount}>{formatMoney(item.amount_cents, item.currency)}</Text>
              <TouchableOpacity
                testID={`expense-row-delete-${item.id}`}
                onPress={() => deleteExpense(item)}
                style={styles.deleteBtn}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Feather name="trash-2" size={18} color={colors.error} />
              </TouchableOpacity>
            </TouchableOpacity>
          )}
        />
      )}

      <AddExpenseModal
        visible={showAdd}
        expense={editing}
        prefill={prefill}
        categories={categories}
        vendors={vendors}
        onClose={() => { setShowAdd(false); setPrefill(null); }}
        onSaved={() => { setShowAdd(false); setPrefill(null); load(); }}
        onVendorCreated={(v) => setVendors((prev) => [...prev, v])}
      />

      <ManageCategoriesModal
        visible={showManageCategories}
        categories={categories}
        onClose={() => setShowManageCategories(false)}
        onChanged={load}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.surface },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
  },
  title: { fontSize: 28, fontWeight: "600", color: colors.onSurface, letterSpacing: -0.5 },
  headerActions: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  iconBtn: {
    width: 40, height: 40, borderRadius: radius.pill,
    alignItems: "center", justifyContent: "center",
    borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.surfaceSecondary,
  },
  newBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: colors.brand,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
  },
  newBtnText: { color: colors.onBrandPrimary, fontWeight: "500", fontSize: typography.base },
  list: { padding: spacing.lg, paddingBottom: 120 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.md,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: spacing.sm,
  },
  rowName: { fontSize: typography.lg, fontWeight: "500", color: colors.onSurface },
  rowSub: { fontSize: typography.base, color: colors.muted, marginTop: 2 },
  rowAmount: { fontSize: typography.lg, fontWeight: "600", color: colors.onSurface },
  deleteBtn: { padding: 4, marginLeft: spacing.xs },
});
