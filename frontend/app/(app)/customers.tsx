import { Feather } from "@expo/vector-icons";
import { useFocusEffect, useRouter } from "expo-router";
import React, { useCallback, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AddCustomerModal } from "@/src/components/AddCustomerModal";
import { Button } from "@/src/components/Button";
import { EmptyState } from "@/src/components/Card";
import { api } from "@/src/lib/api";
import { colors, radius, spacing, typography } from "@/src/lib/theme";
import type { Customer } from "@/src/lib/types";

export default function Customers() {
  const router = useRouter();
  const [items, setItems] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState("");
  const [showAdd, setShowAdd] = useState(false);

  const load = useCallback(async () => {
    try {
      const params = search ? `?q=${encodeURIComponent(search)}` : "";
      const data = await api.get<Customer[]>(`/customers${params}`);
      setItems(data);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [search]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.title}>Customers</Text>
        <TouchableOpacity testID="customers-add-btn" onPress={() => setShowAdd(true)} style={styles.newBtn}>
          <Feather name="plus" size={16} color={colors.onBrandPrimary} />
          <Text style={styles.newBtnText}>Add</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.searchWrap}>
        <Feather name="search" size={16} color={colors.muted} />
        <TextInput
          testID="customers-search"
          placeholder="Search customers"
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
          testID="customers-empty"
          title="No customers yet"
          subtitle="Add your first customer to start invoicing."
          action={<Button testID="customers-empty-add" title="Add Customer" onPress={() => setShowAdd(true)} />}
        />
      ) : (
        <FlatList
          data={items}
          keyExtractor={(i) => i.id}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={colors.brand} />}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <TouchableOpacity
              testID={`customer-row-${item.id}`}
              style={styles.row}
              onPress={() => router.push({ pathname: "/customers/[id]", params: { id: item.id } })}
              activeOpacity={0.85}
            >
              <View style={styles.avatar}>
                <Text style={styles.avatarText}>{item.name.slice(0, 1).toUpperCase()}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.rowName}>{item.name}</Text>
                <Text style={styles.rowSub}>{item.email || item.phone || item.company || "—"}</Text>
              </View>
              <Feather name="chevron-right" size={18} color={colors.muted} />
            </TouchableOpacity>
          )}
        />
      )}

      <AddCustomerModal
        visible={showAdd}
        onClose={() => setShowAdd(false)}
        onCreated={() => { setShowAdd(false); load(); }}
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
});
