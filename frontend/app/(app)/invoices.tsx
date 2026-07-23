import { Feather } from "@expo/vector-icons";
import { useFocusEffect, useRouter } from "expo-router";
import React, { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { EmptyState } from "@/src/components/Card";
import { StatusPill } from "@/src/components/StatusPill";
import { api } from "@/src/lib/api";
import { formatMoney } from "@/src/lib/money";
import { colors, radius, spacing, typography } from "@/src/lib/theme";
import type { Invoice, InvoiceStatus } from "@/src/lib/types";

const FILTERS: ({ key: "ALL"; label: string } | { key: InvoiceStatus; label: string })[] = [
  { key: "ALL", label: "All" },
  { key: "DRAFT", label: "Draft" },
  { key: "SENT", label: "Sent" },
  { key: "PAID", label: "Paid" },
  { key: "OVERDUE", label: "Overdue" },
  { key: "VOID", label: "Void" },
];

export default function Invoices() {
  const router = useRouter();
  const [items, setItems] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<"ALL" | InvoiceStatus>("ALL");
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    try {
      const data = await api.get<Invoice[]>("/invoices");
      setItems(data);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const filtered = useMemo(() => {
    return items.filter((inv) => {
      if (filter !== "ALL" && inv.status !== filter) return false;
      if (search) {
        const hay = `${inv.number} ${inv.customer?.name || ""}`.toLowerCase();
        if (!hay.includes(search.toLowerCase())) return false;
      }
      return true;
    });
  }, [items, filter, search]);

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.title}>Invoices</Text>
        <TouchableOpacity testID="invoices-new-btn" onPress={() => router.push("/invoices/new")} style={styles.newBtn} activeOpacity={0.85}>
          <Feather name="plus" size={16} color={colors.onBrandPrimary} />
          <Text style={styles.newBtnText}>New</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.searchWrap}>
        <Feather name="search" size={16} color={colors.muted} />
        <TextInput
          testID="invoices-search"
          placeholder="Search by number or customer"
          placeholderTextColor={colors.muted}
          style={styles.searchInput}
          value={search}
          onChangeText={setSearch}
        />
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.chipsRow}
        style={styles.chipsScroll}
      >
        {FILTERS.map((f) => {
          const active = filter === f.key;
          return (
            <TouchableOpacity
              key={f.key}
              testID={`invoices-chip-${f.key.toLowerCase()}`}
              onPress={() => setFilter(f.key)}
              activeOpacity={0.85}
              style={[styles.chip, active && styles.chipActive]}
            >
              <Text style={[styles.chipText, active && styles.chipTextActive]}>{f.label}</Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {loading ? (
        <ActivityIndicator style={{ marginTop: 40 }} size="large" color={colors.brand} />
      ) : filtered.length === 0 ? (
        <EmptyState
          testID="invoices-empty"
          title="No invoices match this filter"
          subtitle="Try a different filter or create a new invoice."
        />
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(i) => i.id}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={colors.brand} />}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <TouchableOpacity
              testID={`invoice-card-${item.number}`}
              style={styles.card}
              onPress={() => router.push({ pathname: "/invoices/[id]", params: { id: item.id } })}
              activeOpacity={0.85}
            >
              <View style={{ flex: 1 }}>
                <Text style={styles.cardNumber}>{item.number}</Text>
                <Text style={styles.cardCustomer}>{item.customer?.name || "—"}</Text>
                <Text style={styles.cardDate}>Due {item.due_date}</Text>
              </View>
              <View style={{ alignItems: "flex-end", gap: 6 }}>
                <Text style={styles.cardAmount}>{formatMoney(item.total_cents, item.currency)}</Text>
                <StatusPill status={item.status} />
              </View>
            </TouchableOpacity>
          )}
        />
      )}
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
  chipsScroll: { flexGrow: 0, marginTop: spacing.sm, maxHeight: 56 },
  chipsRow: { paddingHorizontal: spacing.lg, gap: spacing.sm, alignItems: "center", height: 56 },
  chip: {
    flexShrink: 0,
    height: 36,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceSecondary,
    alignItems: "center",
    justifyContent: "center",
  },
  chipActive: { backgroundColor: colors.brandTertiary, borderColor: colors.brand },
  chipText: { color: colors.onSurfaceTertiary, fontSize: typography.base, fontWeight: "500" },
  chipTextActive: { color: colors.brand },
  list: { padding: spacing.lg, paddingBottom: 100 },
  card: {
    flexDirection: "row",
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.lg,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: spacing.sm,
    alignItems: "center",
  },
  cardNumber: { fontSize: typography.lg, fontWeight: "500", color: colors.onSurface },
  cardCustomer: { fontSize: typography.base, color: colors.onSurfaceTertiary, marginTop: 2 },
  cardDate: { fontSize: typography.sm, color: colors.muted, marginTop: 4 },
  cardAmount: { fontSize: 18, fontWeight: "500", color: colors.onSurface },
});
