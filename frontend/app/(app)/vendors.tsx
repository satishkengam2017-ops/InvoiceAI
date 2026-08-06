import { Feather } from "@expo/vector-icons";
import { useFocusEffect } from "expo-router";
import React, { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AddVendorModal } from "@/src/components/AddVendorModal";
import { Button } from "@/src/components/Button";
import { EmptyState } from "@/src/components/Card";
import { api } from "@/src/lib/api";
import { confirmAsync } from "@/src/lib/confirm";
import { colors, radius, spacing, typography, webContent } from "@/src/lib/theme";
import type { Vendor } from "@/src/lib/types";

export default function Vendors() {
  const [items, setItems] = useState<Vendor[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<Vendor | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  const load = useCallback(async () => {
    try {
      const params = search ? `?q=${encodeURIComponent(search)}` : "";
      const data = await api.get<Vendor[]>(`/vendors${params}`);
      setItems(data);
    } catch {
      /* ignore — AuthContext redirects if the session is invalid */
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [search]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const deleteVendor = async (vendor: Vendor) => {
    const ok = await confirmAsync("Delete vendor?", `"${vendor.name}" will be removed from your vendor list. Past expenses are not affected.`);
    if (!ok) return;
    try {
      await api.del(`/vendors/${vendor.id}`);
      setItems((prev) => prev.filter((v) => v.id !== vendor.id));
    } catch (e) {
      Alert.alert("Delete failed", e instanceof Error ? e.message : "Unknown error");
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={[styles.header, webContent]}>
        <Text style={styles.title}>Vendors</Text>
        <TouchableOpacity testID="vendors-add-btn" onPress={() => { setEditing(null); setShowAdd(true); }} style={styles.newBtn}>
          <Feather name="plus" size={16} color={colors.onBrandPrimary} />
          <Text style={styles.newBtnText}>Add</Text>
        </TouchableOpacity>
      </View>

      <View style={[styles.searchWrap, webContent]}>
        <Feather name="search" size={16} color={colors.muted} />
        <TextInput
          testID="vendors-search"
          placeholder="Search vendors"
          placeholderTextColor={colors.muted}
          style={styles.searchInput}
          value={search}
          onChangeText={setSearch}
          onSubmitEditing={load}
        />
      </View>

      {loading ? (
        <ActivityIndicator style={{ marginTop: 40 }} size="large" color={colors.brand} />
      ) : items.length === 0 ? (
        <EmptyState
          testID="vendors-empty"
          title="No vendors yet"
          subtitle="Add a vendor to attach it to your expenses."
          action={<Button testID="vendors-empty-add" title="Add Vendor" onPress={() => { setEditing(null); setShowAdd(true); }} />}
        />
      ) : (
        <FlatList
          data={items}
          keyExtractor={(i) => i.id}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={colors.brand} />}
          contentContainerStyle={[styles.list, webContent]}
          renderItem={({ item }) => (
            <TouchableOpacity
              testID={`vendor-row-${item.id}`}
              style={styles.row}
              onPress={() => { setEditing(item); setShowAdd(true); }}
              activeOpacity={0.85}
            >
              <View style={styles.avatar}>
                <Text style={styles.avatarText}>{item.name.slice(0, 1).toUpperCase()}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.rowName}>{item.name}</Text>
                <Text style={styles.rowSub}>{item.email || item.phone || "—"}</Text>
              </View>
              <TouchableOpacity
                testID={`vendor-row-delete-${item.id}`}
                onPress={() => deleteVendor(item)}
                style={styles.deleteBtn}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Feather name="trash-2" size={18} color={colors.error} />
              </TouchableOpacity>
            </TouchableOpacity>
          )}
        />
      )}

      <AddVendorModal
        visible={showAdd}
        vendor={editing}
        onClose={() => setShowAdd(false)}
        onSaved={() => { setShowAdd(false); load(); }}
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
  searchWrap: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.sm,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: colors.surfaceSecondary,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
  },
  searchInput: { flex: 1, height: 44, color: colors.onSurface, fontSize: typography.base },
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
  avatar: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: colors.brandTertiary,
    alignItems: "center", justifyContent: "center",
  },
  avatarText: { color: colors.brand, fontSize: typography.lg, fontWeight: "600" },
  rowName: { fontSize: typography.lg, fontWeight: "500", color: colors.onSurface },
  rowSub: { fontSize: typography.base, color: colors.muted, marginTop: 2 },
  deleteBtn: { padding: 4, marginRight: spacing.xs },
});
