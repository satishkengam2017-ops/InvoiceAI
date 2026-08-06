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
import { DateField } from "@/src/components/DateField";
import { StatusPill } from "@/src/components/StatusPill";
import { api } from "@/src/lib/api";
import { downloadCsv, toCsv, todayStamp } from "@/src/lib/csv";
import { formatMoney } from "@/src/lib/money";
import { colors, radius, spacing, typography, webContent } from "@/src/lib/theme";
import type { Estimate, EstimateStatus, Invoice, InvoiceStatus } from "@/src/lib/types";

type Mode = "INVOICES" | "ESTIMATES";

const INVOICE_FILTERS: ({ key: "ALL"; label: string } | { key: InvoiceStatus; label: string })[] = [
  { key: "ALL", label: "All" },
  { key: "DRAFT", label: "Draft" },
  { key: "SENT", label: "Sent" },
  { key: "PAID", label: "Paid" },
  { key: "OVERDUE", label: "Overdue" },
  { key: "VOID", label: "Void" },
];

const ESTIMATE_FILTERS: ({ key: "ALL"; label: string } | { key: EstimateStatus; label: string })[] = [
  { key: "ALL", label: "All" },
  { key: "DRAFT", label: "Draft" },
  { key: "SENT", label: "Sent" },
  { key: "ACCEPTED", label: "Accepted" },
  { key: "DECLINED", label: "Declined" },
  { key: "CONVERTED", label: "Converted" },
];

export default function Invoices() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("INVOICES");

  const [invoiceItems, setInvoiceItems] = useState<Invoice[]>([]);
  const [invoiceFilter, setInvoiceFilter] = useState<"ALL" | InvoiceStatus>("ALL");

  const [estimateItems, setEstimateItems] = useState<Estimate[]>([]);
  const [estimateFilter, setEstimateFilter] = useState<"ALL" | EstimateStatus>("ALL");

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

  const load = useCallback(async () => {
    try {
      const [invoicesResult, estimatesResult] = await Promise.allSettled([
        api.get<Invoice[]>("/invoices"),
        api.get<Estimate[]>("/estimates"),
      ]);
      if (invoicesResult.status === "fulfilled") setInvoiceItems(invoicesResult.value);
      if (estimatesResult.status === "fulfilled") setEstimateItems(estimatesResult.value);
    } catch {
      /* ignore — AuthContext redirects if the session is invalid */
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const filteredInvoices = useMemo(() => {
    return invoiceItems.filter((inv) => {
      if (invoiceFilter !== "ALL" && inv.status !== invoiceFilter) return false;
      if (search) {
        const hay = `${inv.number} ${inv.customer?.name || ""}`.toLowerCase();
        if (!hay.includes(search.toLowerCase())) return false;
      }
      return true;
    });
  }, [invoiceItems, invoiceFilter, search]);

  const filteredEstimates = useMemo(() => {
    return estimateItems.filter((est) => {
      if (estimateFilter !== "ALL" && est.status !== estimateFilter) return false;
      if (search) {
        const hay = `${est.number} ${est.customer?.name || ""}`.toLowerCase();
        if (!hay.includes(search.toLowerCase())) return false;
      }
      return true;
    });
  }, [estimateItems, estimateFilter, search]);

  const exportCsv = async () => {
    // ISO YYYY-MM-DD strings compare correctly as plain strings.
    const inRange = (inv: Invoice) => {
      const d = inv.issue_date || (inv.created_at || "").slice(0, 10);
      if (fromDate.trim() && d < fromDate.trim()) return false;
      if (toDate.trim() && d > toDate.trim()) return false;
      return true;
    };
    const rows = filteredInvoices.filter(inRange).map((inv) => {
      const lineDesc = inv.line_items
        .map((li) => `${li.quantity} x ${li.name}${li.description ? ` (${li.description})` : ""}`)
        .join("; ");
      const invoiceStatus = inv.status === "PAID" ? "Paid" : inv.status === "VOID" ? "Void" : "Unpaid";
      const payStatus =
        inv.status === "PAID" ? "Paid" : (inv.amount_paid_cents || 0) > 0 ? "Partially Paid" : "Unpaid";
      return [
        inv.issue_date,
        invoiceStatus,
        inv.customer?.name || "",
        lineDesc,
        formatMoney(inv.total_cents, inv.currency),
        payStatus,
      ];
    });
    const csv = toCsv(
      ["Invoice Date", "Invoice Status", "Customer Name", "Description / Line Items", "Amount Charged", "Payment Status"],
      rows
    );
    await downloadCsv(`invoices_report_${todayStamp()}.csv`, csv);
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={[styles.header, webContent]}>
        <Text style={styles.title}>{mode === "INVOICES" ? "Invoices" : "Estimates"}</Text>
        <TouchableOpacity
          testID="invoices-new-btn"
          onPress={() => router.push(mode === "INVOICES" ? "/invoices/new" : "/estimates/new")}
          style={styles.newBtn}
          activeOpacity={0.85}
        >
          <Feather name="plus" size={16} color={colors.onBrandPrimary} />
          <Text style={styles.newBtnText}>New</Text>
        </TouchableOpacity>
      </View>

      {/* Invoices/Estimates segmented toggle */}
      <View style={[styles.segmentRow, webContent]}>
        <TouchableOpacity
          testID="mode-invoices"
          onPress={() => setMode("INVOICES")}
          style={[styles.segment, mode === "INVOICES" && styles.segmentActive]}
        >
          <Text style={[styles.segmentText, mode === "INVOICES" && styles.segmentTextActive]}>Invoices</Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID="mode-estimates"
          onPress={() => setMode("ESTIMATES")}
          style={[styles.segment, mode === "ESTIMATES" && styles.segmentActive]}
        >
          <Text style={[styles.segmentText, mode === "ESTIMATES" && styles.segmentTextActive]}>Estimates</Text>
        </TouchableOpacity>
      </View>

      <View style={[styles.searchWrap, webContent]}>
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

      {/* Report export: date range + CSV download — invoices only */}
      {mode === "INVOICES" ? (
        <View style={[styles.exportSection, webContent]}>
          <View style={styles.dateRow}>
            <View style={styles.dateFieldWrap}>
              <DateField testID="invoices-from-date" placeholder="From date" value={fromDate} onChange={setFromDate} maximumDate={toDate ? new Date(toDate) : undefined} />
            </View>
            <View style={styles.dateFieldWrap}>
              <DateField testID="invoices-to-date" placeholder="To date" value={toDate} onChange={setToDate} minimumDate={fromDate ? new Date(fromDate) : undefined} />
            </View>
          </View>
          <TouchableOpacity testID="invoices-download-csv" style={styles.csvBtn} onPress={exportCsv} activeOpacity={0.85}>
            <Feather name="download" size={14} color={colors.brand} />
            <Text style={styles.csvBtnText}>Download CSV</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.chipsRow}
        style={[styles.chipsScroll, webContent]}
      >
        {(mode === "INVOICES" ? INVOICE_FILTERS : ESTIMATE_FILTERS).map((f) => {
          const active = mode === "INVOICES" ? invoiceFilter === f.key : estimateFilter === f.key;
          return (
            <TouchableOpacity
              key={f.key}
              testID={`${mode === "INVOICES" ? "invoices" : "estimates"}-chip-${f.key.toLowerCase()}`}
              onPress={() => (mode === "INVOICES" ? setInvoiceFilter(f.key as "ALL" | InvoiceStatus) : setEstimateFilter(f.key as "ALL" | EstimateStatus))}
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
      ) : mode === "INVOICES" ? (
        filteredInvoices.length === 0 ? (
          <EmptyState
            testID="invoices-empty"
            title="No invoices match this filter"
            subtitle="Try a different filter or create a new invoice."
          />
        ) : (
          <FlatList
            data={filteredInvoices}
            keyExtractor={(i) => i.id}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={colors.brand} />}
            contentContainerStyle={[styles.list, webContent]}
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
        )
      ) : filteredEstimates.length === 0 ? (
        <EmptyState
          testID="estimates-empty"
          title="No estimates match this filter"
          subtitle="Try a different filter or create a new estimate."
        />
      ) : (
        <FlatList
          data={filteredEstimates}
          keyExtractor={(i) => i.id}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={colors.brand} />}
          contentContainerStyle={[styles.list, webContent]}
          renderItem={({ item }) => (
            <TouchableOpacity
              testID={`estimate-card-${item.number}`}
              style={styles.card}
              onPress={() => router.push({ pathname: "/estimates/[id]", params: { id: item.id } })}
              activeOpacity={0.85}
            >
              <View style={{ flex: 1 }}>
                <Text style={styles.cardNumber}>{item.number}</Text>
                <Text style={styles.cardCustomer}>{item.customer?.name || "—"}</Text>
                <Text style={styles.cardDate}>{item.expiry_date ? `Expires ${item.expiry_date}` : "No expiry"}</Text>
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
  segmentRow: {
    flexDirection: "row",
    marginHorizontal: spacing.lg,
    marginTop: spacing.sm,
    backgroundColor: colors.surfaceTertiary,
    borderRadius: radius.pill,
    padding: 3,
  },
  segment: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    height: 36,
    borderRadius: radius.pill,
  },
  segmentActive: { backgroundColor: colors.surfaceSecondary },
  segmentText: { fontSize: typography.base, fontWeight: "500", color: colors.onSurfaceTertiary },
  segmentTextActive: { color: colors.onSurface },
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
  exportSection: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.sm,
  },
  dateRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  dateFieldWrap: { flex: 1 },
  csvBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "flex-end",
    gap: 6,
    height: 40,
    marginTop: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.brand,
    backgroundColor: colors.brandTertiary,
  },
  csvBtnText: { color: colors.brand, fontWeight: "500", fontSize: typography.sm },
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
