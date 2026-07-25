import { Feather } from "@expo/vector-icons";
import { useFocusEffect, useRouter } from "expo-router";
import React, { useCallback, useState } from "react";
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Card, EmptyState } from "@/src/components/Card";
import { StatusPill } from "@/src/components/StatusPill";
import { useAuth } from "@/src/context/AuthContext";
import { api } from "@/src/lib/api";
import { formatMoney } from "@/src/lib/money";
import { colors, radius, spacing, typography, webContent } from "@/src/lib/theme";
import type { DashboardSummary, Invoice } from "@/src/lib/types";

export default function Dashboard() {
  const router = useRouter();
  const { business } = useAuth();
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [recent, setRecent] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const [s, r] = await Promise.all([
        api.get<DashboardSummary>("/dashboard/summary"),
        api.get<Invoice[]>("/invoices"),
      ]);
      setSummary(s);
      setRecent(r.slice(0, 5));
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const currency = summary?.currency || business?.currency || "USD";
  const maxDayBar = Math.max(1, ...(summary?.chart_days?.days || []).map((d) => d.revenue_cents));
  const maxMonthBar = Math.max(1, ...(summary?.chart_year?.months || []).map((m) => m.revenue_cents));

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <ScrollView
        contentContainerStyle={[styles.scroll, webContent]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={colors.brand} />}
      >
        <View style={styles.header}>
          <Text style={styles.hello}>Hi, {business?.name}</Text>
          <Text style={styles.tagline}>Here&apos;s your business at a glance.</Text>
        </View>

        {loading ? (
          <ActivityIndicator size="large" color={colors.brand} style={{ marginTop: 40 }} />
        ) : (
          <>
            {/* Hero metric */}
            <Card testID="dashboard-revenue-card" style={styles.heroCard}>
              <Text style={styles.metricLabel}>Revenue this month</Text>
              <Text style={styles.heroAmount}>{formatMoney(summary?.revenue_this_month_cents || 0, currency)}</Text>
              <View style={styles.metricRow}>
                <View style={styles.metricSub}>
                  <Text style={styles.subLabel}>Outstanding</Text>
                  <Text style={styles.subValue}>{formatMoney(summary?.outstanding_cents || 0, currency)}</Text>
                </View>
                <View style={styles.metricSub}>
                  <Text style={styles.subLabel}>Overdue</Text>
                  <Text style={[styles.subValue, { color: (summary?.overdue_cents || 0) > 0 ? colors.error : colors.onSurface }]}>
                    {formatMoney(summary?.overdue_cents || 0, currency)}
                  </Text>
                </View>
              </View>
            </Card>

            {/* Plan usage */}
            {summary?.plan_usage ? (
              <Card testID="dashboard-plan-card" style={{ marginTop: spacing.md }}>
                <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                  <View>
                    <Text style={styles.metricLabel}>{summary.plan} plan</Text>
                    <Text style={styles.planUsage}>
                      {summary.plan_usage.used} / {summary.plan_usage.limit} invoices this {summary.plan_usage.scope}
                    </Text>
                  </View>
                  <TouchableOpacity testID="dashboard-manage-plan" onPress={() => router.push("/(app)/settings")}>
                    <Text style={styles.link}>Manage</Text>
                  </TouchableOpacity>
                </View>
                <View style={styles.progressBar}>
                  <View style={[styles.progressFill, { width: `${Math.min(100, (summary.plan_usage.used / summary.plan_usage.limit) * 100)}%` }]} />
                </View>
              </Card>
            ) : null}

            {/* Revenue (Last Month) */}
            <Card testID="dashboard-chart-days-card" style={{ marginTop: spacing.md }}>
              <View style={styles.chartHeader}>
                <Text style={styles.sectionTitle}>Revenue (Last Month)</Text>
                <View style={styles.rangeBadge}>
                  <Feather name="calendar" size={12} color={colors.muted} />
                  <Text style={styles.rangeBadgeText}>{summary?.chart_days?.range_label}</Text>
                </View>
              </View>
              <Text style={styles.chartTotal}>{formatMoney(summary?.chart_days?.total_cents || 0, currency)}</Text>
              <Text style={styles.chartTotalLabel}>Total Revenue</Text>
              <View style={[styles.chartRow, { marginTop: spacing.lg }]}>
                {(summary?.chart_days?.days || []).map((d) => (
                  <View key={d.day} style={styles.chartCol}>
                    <View style={styles.barTrack}>
                      <View style={[styles.bar, { height: `${(d.revenue_cents / maxDayBar) * 100}%` }]} />
                    </View>
                    {d.day === 1 || d.day % 5 === 0 ? <Text style={styles.barLabel}>{d.day}</Text> : null}
                  </View>
                ))}
              </View>
            </Card>

            {/* Revenue (Jan - Dec) */}
            <Card testID="dashboard-chart-year-card" style={{ marginTop: spacing.md }}>
              <View style={styles.chartHeader}>
                <Text style={styles.sectionTitle}>Revenue (Jan - Dec)</Text>
                <View style={styles.rangeBadge}>
                  <Feather name="calendar" size={12} color={colors.muted} />
                  <Text style={styles.rangeBadgeText}>{summary?.chart_year?.range_label}</Text>
                </View>
              </View>
              <Text style={styles.chartTotal}>{formatMoney(summary?.chart_year?.total_cents || 0, currency)}</Text>
              <Text style={styles.chartTotalLabel}>Total Revenue (Year to Date)</Text>
              <View style={[styles.chartRow, { marginTop: spacing.lg }]}>
                {(summary?.chart_year?.months || []).map((m) => {
                  const isCurrent = m.month === summary?.chart_year?.current_month;
                  return (
                    <View key={`${m.year}-${m.month}`} style={styles.chartCol}>
                      <View style={styles.barTrack}>
                        <View
                          style={[
                            styles.bar,
                            { height: `${(m.revenue_cents / maxMonthBar) * 100}%` },
                            isCurrent ? styles.barCurrent : null,
                          ]}
                        />
                      </View>
                      <Text style={styles.barLabel}>{m.label}</Text>
                    </View>
                  );
                })}
              </View>
              <View style={styles.legendRow}>
                <View style={styles.legendItem}>
                  <View style={[styles.legendSwatch, { backgroundColor: colors.brand }]} />
                  <Text style={styles.legendText}>Current Month</Text>
                </View>
                <View style={styles.legendItem}>
                  <View style={[styles.legendSwatch, { backgroundColor: colors.brandSecondary }]} />
                  <Text style={styles.legendText}>Other Months</Text>
                </View>
              </View>
            </Card>

            {/* Recent invoices */}
            <View style={styles.recentHeader}>
              <Text style={styles.sectionTitle}>Recent invoices</Text>
              <TouchableOpacity testID="dashboard-see-all" onPress={() => router.push("/(app)/invoices")}>
                <Text style={styles.link}>See all</Text>
              </TouchableOpacity>
            </View>

            {recent.length === 0 ? (
              <EmptyState
                testID="dashboard-empty-invoices"
                title="No invoices yet"
                subtitle="Create your first invoice to see insights."
              />
            ) : (
              recent.map((inv) => (
                <TouchableOpacity
                  key={inv.id}
                  testID={`dashboard-invoice-${inv.number}`}
                  style={styles.invoiceRow}
                  onPress={() => router.push({ pathname: "/invoices/[id]", params: { id: inv.id } })}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={styles.invNumber}>{inv.number}</Text>
                    <Text style={styles.invCustomer}>{inv.customer?.name || "—"}</Text>
                  </View>
                  <View style={{ alignItems: "flex-end", gap: 4 }}>
                    <Text style={styles.invAmount}>{formatMoney(inv.total_cents, inv.currency)}</Text>
                    <StatusPill status={inv.status} />
                  </View>
                </TouchableOpacity>
              ))
            )}
          </>
        )}

        <View style={{ height: 88 }} />
      </ScrollView>

      <TouchableOpacity
        testID="dashboard-new-invoice-fab"
        style={styles.fab}
        onPress={() => router.push("/invoices/new")}
        activeOpacity={0.9}
      >
        <Feather name="plus" size={22} color={colors.onBrandPrimary} />
        <Text style={styles.fabText}>New Invoice</Text>
      </TouchableOpacity>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.surface },
  scroll: { padding: spacing.lg, paddingBottom: 100 },
  header: { marginBottom: spacing.lg, marginTop: spacing.sm },
  hello: { fontSize: 26, fontWeight: "600", color: colors.onSurface, letterSpacing: -0.5 },
  tagline: { fontSize: typography.base, color: colors.muted, marginTop: 4 },
  heroCard: { padding: spacing.xl },
  metricLabel: {
    fontSize: typography.sm,
    color: colors.muted,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    fontWeight: "500",
  },
  heroAmount: {
    fontSize: 36,
    fontWeight: "600",
    color: colors.onSurface,
    marginTop: spacing.sm,
    letterSpacing: -1,
  },
  metricRow: { flexDirection: "row", marginTop: spacing.lg, gap: spacing.lg },
  metricSub: { flex: 1 },
  subLabel: { fontSize: 11, color: colors.muted, textTransform: "uppercase", letterSpacing: 0.5 },
  subValue: { fontSize: 18, fontWeight: "500", color: colors.onSurface, marginTop: 2 },
  planUsage: { fontSize: typography.base, color: colors.onSurface, marginTop: 2 },
  progressBar: { height: 6, backgroundColor: colors.surfaceTertiary, borderRadius: 3, marginTop: spacing.md, overflow: "hidden" },
  progressFill: { height: 6, backgroundColor: colors.brand, borderRadius: 3 },
  link: { color: colors.brand, fontWeight: "500", fontSize: typography.base },
  sectionTitle: {
    fontSize: typography.lg,
    fontWeight: "500",
    color: colors.onSurface,
    marginBottom: spacing.md,
  },
  chartRow: { flexDirection: "row", height: 140, alignItems: "flex-end", gap: spacing.sm },
  chartCol: { flex: 1, alignItems: "center" },
  barTrack: {
    width: "70%",
    height: 110,
    backgroundColor: colors.surface,
    borderRadius: radius.sm,
    justifyContent: "flex-end",
    overflow: "hidden",
  },
  bar: { width: "100%", backgroundColor: colors.brandSecondary, borderRadius: radius.sm, minHeight: 2 },
  barCurrent: { backgroundColor: colors.brand },
  barLabel: { fontSize: 11, color: colors.muted, marginTop: 6 },
  chartHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" },
  rangeBadge: { flexDirection: "row", alignItems: "center", gap: 4 },
  rangeBadgeText: { fontSize: 11, color: colors.muted },
  chartTotal: { fontSize: 28, fontWeight: "600", color: colors.onSurface, marginTop: spacing.sm, letterSpacing: -0.5 },
  chartTotalLabel: { fontSize: typography.sm, color: colors.muted, marginTop: 2 },
  legendRow: { flexDirection: "row", gap: spacing.lg, marginTop: spacing.md, justifyContent: "center" },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 6 },
  legendSwatch: { width: 10, height: 10, borderRadius: 2 },
  legendText: { fontSize: 12, color: colors.muted },
  recentHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: spacing.xl, marginBottom: spacing.md },
  invoiceRow: {
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
  invCustomer: { fontSize: typography.base, color: colors.muted, marginTop: 2 },
  invAmount: { fontSize: typography.lg, fontWeight: "500", color: colors.onSurface },
  fab: {
    position: "absolute",
    right: spacing.lg,
    bottom: 96,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radius.pill,
    backgroundColor: colors.brand,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 6,
  },
  fabText: { color: colors.onBrandPrimary, fontWeight: "500", fontSize: typography.base },
});
