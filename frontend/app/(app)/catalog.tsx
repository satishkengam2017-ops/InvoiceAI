import { Feather } from "@expo/vector-icons";
import { useFocusEffect } from "expo-router";
import React, { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Button } from "@/src/components/Button";
import { EmptyState } from "@/src/components/Card";
import { Input } from "@/src/components/Input";
import { api } from "@/src/lib/api";
import { confirmAsync } from "@/src/lib/confirm";
import { formatMoney, parseCents } from "@/src/lib/money";
import { colors, radius, spacing, typography, webContent } from "@/src/lib/theme";
import type { CatalogItem } from "@/src/lib/types";

export default function Catalog() {
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showAdd, setShowAdd] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api.get<CatalogItem[]>("/catalog");
      setItems(data);
    } catch {
      /* ignore — AuthContext redirects if the session is invalid */
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const deleteItem = async (item: CatalogItem) => {
    const ok = await confirmAsync("Delete item?", `"${item.name}" will be removed from your catalog. Existing invoices are not affected.`);
    if (!ok) return;
    try {
      await api.del(`/catalog/${item.id}`);
      setItems((prev) => prev.filter((i) => i.id !== item.id));
    } catch (e) {
      Alert.alert("Delete failed", e instanceof Error ? e.message : "Unknown error");
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={[styles.header, webContent]}>
        <Text style={styles.title}>Catalog</Text>
        <TouchableOpacity testID="catalog-add-btn" onPress={() => setShowAdd(true)} style={styles.newBtn}>
          <Feather name="plus" size={16} color={colors.onBrandPrimary} />
          <Text style={styles.newBtnText}>Add Item</Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <ActivityIndicator style={{ marginTop: 40 }} size="large" color={colors.brand} />
      ) : items.length === 0 ? (
        <EmptyState
          testID="catalog-empty"
          title="No catalog items"
          subtitle="Save reusable products or services for one-tap adding to invoices."
          action={<Button testID="catalog-empty-add" title="Add Item" onPress={() => setShowAdd(true)} />}
        />
      ) : (
        <FlatList
          data={items}
          keyExtractor={(i) => i.id}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={colors.brand} />}
          contentContainerStyle={[styles.list, webContent]}
          renderItem={({ item }) => (
            <View testID={`catalog-item-${item.id}`} style={styles.row}>
              <View style={{ flex: 1 }}>
                <Text style={styles.name}>{item.name}</Text>
                {item.description ? <Text style={styles.desc}>{item.description}</Text> : null}
                <Text style={styles.meta}>
                  {formatMoney(item.unit_price_cents, item.currency)}
                  {item.unit ? ` / ${item.unit}` : ""}
                  {item.tax_percent ? ` · ${item.tax_percent}% tax` : ""}
                </Text>
              </View>
              <TouchableOpacity
                testID={`catalog-item-delete-${item.id}`}
                onPress={() => deleteItem(item)}
                style={styles.deleteBtn}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Feather name="trash-2" size={18} color={colors.error} />
              </TouchableOpacity>
            </View>
          )}
        />
      )}

      <AddCatalogItemModal visible={showAdd} onClose={() => setShowAdd(false)} onCreated={() => { setShowAdd(false); load(); }} />
    </SafeAreaView>
  );
}

function AddCatalogItemModal({ visible, onClose, onCreated }: { visible: boolean; onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [price, setPrice] = useState("");
  const [unit, setUnit] = useState("");
  const [taxPct, setTaxPct] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const reset = () => {
    setName(""); setDescription(""); setPrice(""); setUnit(""); setTaxPct(""); setErr(null);
  };

  const onSave = async () => {
    if (!name.trim()) return setErr("Name is required");
    if (!price.trim()) return setErr("Price is required");
    setErr(null);
    setSaving(true);
    try {
      await api.post("/catalog", {
        name: name.trim(),
        description: description.trim() || null,
        unit_price_cents: parseCents(price),
        unit: unit.trim() || null,
        tax_percent: parseFloat(taxPct || "0") || 0,
      });
      reset();
      onCreated();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.modalOverlay}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>New catalog item</Text>
              <TouchableOpacity testID="add-catalog-close" onPress={() => { reset(); onClose(); }}>
                <Feather name="x" size={22} color={colors.muted} />
              </TouchableOpacity>
            </View>
            <Input testID="add-catalog-name" label="Name *" value={name} onChangeText={setName} />
            <Input testID="add-catalog-description" label="Description" value={description} onChangeText={setDescription} />
            <Input testID="add-catalog-price" label="Unit price *" keyboardType="decimal-pad" value={price} onChangeText={setPrice} placeholder="0.00" />
            <View style={{ flexDirection: "row", gap: spacing.md }}>
              <View style={{ flex: 1 }}>
                <Input testID="add-catalog-unit" label="Unit (e.g. hour)" value={unit} onChangeText={setUnit} />
              </View>
              <View style={{ flex: 1 }}>
                <Input testID="add-catalog-tax" label="Tax %" keyboardType="decimal-pad" value={taxPct} onChangeText={setTaxPct} />
              </View>
            </View>
            {err ? <Text style={styles.err}>{err}</Text> : null}
            <Button testID="add-catalog-save" title="Save Item" loading={saving} onPress={onSave} />
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
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
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.md,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: spacing.sm,
  },
  deleteBtn: { padding: spacing.sm, marginLeft: spacing.sm },
  name: { fontSize: typography.lg, fontWeight: "500", color: colors.onSurface },
  desc: { fontSize: typography.base, color: colors.muted, marginTop: 2 },
  meta: { fontSize: typography.base, color: colors.onSurface, marginTop: 6 },
  modalOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" },
  modalCard: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    padding: spacing.lg,
    paddingBottom: spacing.xxxl,
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: spacing.lg,
  },
  modalTitle: { fontSize: 20, fontWeight: "600", color: colors.onSurface },
  err: { color: colors.error, marginBottom: spacing.sm, fontSize: typography.base },
});
