import { Feather } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AddCustomerModal } from "@/src/components/AddCustomerModal";
import { Card, EmptyState } from "@/src/components/Card";
import { StatusPill } from "@/src/components/StatusPill";
import { api } from "@/src/lib/api";
import { confirmAsync } from "@/src/lib/confirm";
import { formatMoney } from "@/src/lib/money";
import { colors, radius, spacing, typography, webContent } from "@/src/lib/theme";
import type { Customer } from "@/src/lib/types";

export default function CustomerDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [loading, setLoading] = useState(true);
  const [showEdit, setShowEdit] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const c = await api.get<Customer>(`/customers/${id}`);
      setCustomer(c);
    } catch {
      /* ignore — AuthContext redirects if the session is invalid */
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const deleteCustomer = async () => {
    if (!customer) return;
    const ok = await confirmAsync("Delete customer?", `"${customer.name}" will be removed from your customer list. Their past invoices are not affected.`);
    if (!ok) return;
    try {
      await api.del(`/customers/${customer.id}`);
      router.back();
    } catch (e) {
      Alert.alert("Delete failed", e instanceof Error ? e.message : "Unknown error");
    }
  };

  if (loading || !customer) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <ActivityIndicator style={{ marginTop: 60 }} size="large" color={colors.brand} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <View style={styles.topbar}>
        <TouchableOpacity testID="cust-back" onPress={() => router.back()}>
          <Feather name="chevron-left" size={24} color={colors.onSurface} />
        </TouchableOpacity>
        <Text style={styles.topbarTitle}>{customer.name}</Text>
        <View style={styles.topbarActions}>
          <TouchableOpacity testID="cust-edit" onPress={() => setShowEdit(true)}>
            <Feather name="edit-2" size={20} color={colors.onSurface} />
          </TouchableOpacity>
          <TouchableOpacity testID="cust-delete" onPress={deleteCustomer}>
            <Feather name="trash-2" size={20} color={colors.error} />
          </TouchableOpacity>
        </View>
      </View>

      <ScrollView contentContainerStyle={[styles.scroll, webContent]}>
        <Card style={styles.hero}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{customer.name.slice(0, 1).toUpperCase()}</Text>
          </View>
          <Text style={styles.name}>{customer.name}</Text>
          {customer.company ? <Text style={styles.muted}>{customer.company}</Text> : null}
          {customer.email ? <Text style={styles.muted}>{customer.email}</Text> : null}
          {customer.phone ? <Text style={styles.muted}>{customer.phone}</Text> : null}
          {customer.address_line1 ? <Text style={styles.muted}>{customer.address_line1}</Text> : null}
          {[customer.city, customer.region, customer.postal_code].filter(Boolean).join(", ") ? (
            <Text style={styles.muted}>
              {[customer.city, customer.region, customer.postal_code].filter(Boolean).join(", ")}
            </Text>
          ) : null}
          {customer.country ? <Text style={styles.muted}>{customer.country}</Text> : null}
        </Card>

        <Card style={styles.card}>
          <Text style={styles.sectionLabel}>Lifetime revenue</Text>
          <Text style={styles.bigAmount}>
            {formatMoney(customer.lifetime_revenue_cents || 0, customer.invoices?.[0]?.currency || "USD")}
          </Text>
          <Text style={styles.muted}>Across {customer.invoices?.length || 0} invoices</Text>
        </Card>

        <Text style={styles.header}>Invoices</Text>
        {!customer.invoices || customer.invoices.length === 0 ? (
          <EmptyState title="No invoices yet" subtitle="Create the first invoice for this customer." />
        ) : (
          customer.invoices.map((inv) => (
            <TouchableOpacity
              key={inv.id}
              testID={`cust-invoice-${inv.number}`}
              style={styles.invRow}
              onPress={() => router.push({ pathname: "/invoices/[id]", params: { id: inv.id } })}
            >
              <View style={{ flex: 1 }}>
                <Text style={styles.invNumber}>{inv.number}</Text>
                <Text style={styles.muted}>{inv.issue_date}</Text>
              </View>
              <View style={{ alignItems: "flex-end", gap: 4 }}>
                <Text style={styles.invAmount}>{formatMoney(inv.total_cents, inv.currency)}</Text>
                <StatusPill status={inv.status} />
              </View>
            </TouchableOpacity>
          ))
        )}
      </ScrollView>

      <AddCustomerModal
        visible={showEdit}
        customer={customer}
        onClose={() => setShowEdit(false)}
        onSaved={(updated) => { setShowEdit(false); setCustomer((prev) => (prev ? { ...prev, ...updated } : updated)); }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.surface },
  topbar: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  topbarActions: { flexDirection: "row", alignItems: "center", gap: spacing.lg },
  topbarTitle: { fontSize: typography.lg, fontWeight: "500", color: colors.onSurface },
  scroll: { padding: spacing.lg },
  hero: { alignItems: "center", padding: spacing.xl, marginBottom: spacing.md },
  avatar: {
    width: 64, height: 64, borderRadius: 32,
    backgroundColor: colors.brandTertiary,
    alignItems: "center", justifyContent: "center",
    marginBottom: spacing.md,
  },
  avatarText: { color: colors.brand, fontSize: 24, fontWeight: "600" },
  name: { fontSize: 22, fontWeight: "600", color: colors.onSurface, marginBottom: 4 },
  muted: { fontSize: typography.base, color: colors.muted, marginTop: 2 },
  card: { marginBottom: spacing.md },
  sectionLabel: { fontSize: 11, fontWeight: "500", color: colors.muted, textTransform: "uppercase", letterSpacing: 0.5 },
  bigAmount: { fontSize: 32, fontWeight: "600", color: colors.onSurface, marginTop: 4, letterSpacing: -0.5 },
  header: { fontSize: typography.lg, fontWeight: "500", color: colors.onSurface, marginBottom: spacing.md, marginTop: spacing.sm },
  invRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.md,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: spacing.sm,
  },
  invNumber: { fontSize: typography.lg, fontWeight: "500", color: colors.onSurface },
  invAmount: { fontSize: typography.lg, fontWeight: "500", color: colors.onSurface },
});
