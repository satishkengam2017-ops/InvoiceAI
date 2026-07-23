import { Feather } from "@expo/vector-icons";
import * as Print from "expo-print";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as Sharing from "expo-sharing";
import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Button } from "@/src/components/Button";
import { Input } from "@/src/components/Input";
import { StatusPill } from "@/src/components/StatusPill";
import { useAuth } from "@/src/context/AuthContext";
import { api } from "@/src/lib/api";
import { invoiceHtml } from "@/src/lib/invoicePdf";
import { formatMoney, parseCents } from "@/src/lib/money";
import { colors, radius, spacing, typography } from "@/src/lib/theme";
import type { Business, Invoice } from "@/src/lib/types";

export default function InvoiceDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { business } = useAuth();

  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [showPayModal, setShowPayModal] = useState(false);
  const [payAmount, setPayAmount] = useState("");
  const [showActions, setShowActions] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const inv = await api.get<Invoice>(`/invoices/${id}`);
      setInvoice(inv);
    } catch (e) {
      Alert.alert("Error", e instanceof Error ? e.message : "Failed to load");
      router.back();
    } finally {
      setLoading(false);
    }
  }, [id, router]);

  useEffect(() => { load(); }, [load]);

  if (loading || !invoice || !business) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <ActivityIndicator style={{ marginTop: 60 }} size="large" color={colors.brand} />
      </SafeAreaView>
    );
  }

  const balance = invoice.total_cents - (invoice.amount_paid_cents || 0);
  const isPaid = invoice.status === "PAID";
  const isVoid = invoice.status === "VOID";

  const share = async () => {
    setBusy(true);
    try {
      const html = invoiceHtml(invoice, business as Business);
      const { uri } = await Print.printToFileAsync({ html, base64: false });
      const canShare = await Sharing.isAvailableAsync();
      if (canShare) {
        await Sharing.shareAsync(uri, {
          mimeType: "application/pdf",
          dialogTitle: `Send ${invoice.number}`,
          UTI: "com.adobe.pdf",
        });
      } else {
        Alert.alert("Sharing unavailable", "Sharing isn't available on this device.");
      }
      // Mark as SENT if it was DRAFT
      if (invoice.status === "DRAFT") {
        const updated = await api.post<Invoice>(`/invoices/${invoice.id}/send`, {});
        setInvoice(updated);
      }
    } catch (e) {
      Alert.alert("Share failed", e instanceof Error ? e.message : "Unknown error");
    } finally {
      setBusy(false);
    }
  };

  const openPay = () => {
    setPayAmount((balance / 100).toString());
    setShowPayModal(true);
  };

  const recordPayment = async () => {
    const cents = parseCents(payAmount);
    if (cents <= 0) return;
    setBusy(true);
    try {
      const updated = await api.post<Invoice>(`/invoices/${invoice.id}/mark-paid`, {
        amount_cents: cents,
        method: "manual",
      });
      setInvoice(updated);
      setShowPayModal(false);
    } catch (e) {
      Alert.alert("Error", e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  const voidInvoice = async () => {
    Alert.alert("Void invoice?", "This can't be undone.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Void",
        style: "destructive",
        onPress: async () => {
          setBusy(true);
          try {
            const updated = await api.post<Invoice>(`/invoices/${invoice.id}/void`, {});
            setInvoice(updated);
            setShowActions(false);
          } catch (e) {
            Alert.alert("Error", e instanceof Error ? e.message : "Failed");
          } finally {
            setBusy(false);
          }
        },
      },
    ]);
  };

  const duplicate = async () => {
    setBusy(true);
    try {
      const newInv = await api.post<Invoice>(`/invoices/${invoice.id}/duplicate`, {});
      setShowActions(false);
      router.replace({ pathname: "/invoices/[id]", params: { id: newInv.id } });
    } catch (e) {
      Alert.alert("Error", e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  const openStripe = () => {
    if (invoice.stripe_payment_url) Linking.openURL(invoice.stripe_payment_url);
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <View style={styles.topbar}>
        <TouchableOpacity testID="invoice-back" onPress={() => router.back()}>
          <Feather name="chevron-left" size={24} color={colors.onSurface} />
        </TouchableOpacity>
        <Text style={styles.topbarTitle}>{invoice.number}</Text>
        <TouchableOpacity testID="invoice-more" onPress={() => setShowActions(true)}>
          <Feather name="more-horizontal" size={22} color={colors.onSurface} />
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={styles.scroll}>
        {/* Status row */}
        <View style={styles.statusRow}>
          <StatusPill status={invoice.status} testID="invoice-status" />
          <Text style={styles.metaText}>Due {invoice.due_date}</Text>
        </View>

        {/* Amount hero */}
        <View style={styles.amountCard}>
          <Text style={styles.amountLabel}>Total</Text>
          <Text testID="invoice-total" style={styles.amountValue}>{formatMoney(invoice.total_cents, invoice.currency)}</Text>
          {invoice.amount_paid_cents ? (
            <>
              <Text style={styles.amountPaid}>Paid {formatMoney(invoice.amount_paid_cents, invoice.currency)}</Text>
              {balance > 0 ? <Text style={styles.balance}>Balance {formatMoney(balance, invoice.currency)}</Text> : null}
            </>
          ) : null}
        </View>

        {/* Bill to */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Bill to</Text>
          <Text style={styles.customerName}>{invoice.customer?.name}</Text>
          {invoice.customer?.company ? <Text style={styles.muted}>{invoice.customer.company}</Text> : null}
          {invoice.customer?.email ? <Text style={styles.muted}>{invoice.customer.email}</Text> : null}
        </View>

        {/* Line items */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Line items</Text>
          {invoice.line_items.map((li, idx) => (
            <View key={idx} style={styles.lineItem}>
              <View style={{ flex: 1 }}>
                <Text style={styles.lineName}>{li.name}</Text>
                {li.description ? <Text style={styles.muted}>{li.description}</Text> : null}
                <Text style={styles.muted}>
                  {li.quantity} × {formatMoney(li.unit_price_cents, invoice.currency)}
                  {li.tax_percent ? ` · ${li.tax_percent}% tax` : ""}
                </Text>
              </View>
              <Text style={styles.lineTotal}>
                {formatMoney(Math.round(li.quantity * li.unit_price_cents * (1 + (li.tax_percent || 0) / 100)), invoice.currency)}
              </Text>
            </View>
          ))}

          <View style={styles.totalsBlock}>
            <TotalRow label="Subtotal" value={formatMoney(invoice.subtotal_cents, invoice.currency)} />
            {invoice.tax_total_cents ? <TotalRow label="Tax" value={formatMoney(invoice.tax_total_cents, invoice.currency)} /> : null}
            {invoice.discount_cents ? <TotalRow label="Discount" value={`- ${formatMoney(invoice.discount_cents, invoice.currency)}`} /> : null}
            <View style={styles.totalDivider} />
            <TotalRow label="Total" value={formatMoney(invoice.total_cents, invoice.currency)} bold />
          </View>
        </View>

        {/* Payment URL */}
        {invoice.stripe_payment_url ? (
          <TouchableOpacity testID="invoice-pay-link" onPress={openStripe} style={styles.payLinkCard}>
            <Feather name="external-link" size={16} color={colors.brand} />
            <Text style={styles.payLinkText}>Open payment link</Text>
          </TouchableOpacity>
        ) : null}

        {invoice.notes ? (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>Notes</Text>
            <Text style={styles.notes}>{invoice.notes}</Text>
          </View>
        ) : null}

        {invoice.terms ? (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>Terms</Text>
            <Text style={styles.terms}>{invoice.terms}</Text>
          </View>
        ) : null}

        <View style={{ height: 120 }} />
      </ScrollView>

      {/* Action bar */}
      {!isVoid ? (
        <View style={styles.actionBar}>
          <TouchableOpacity
            testID="invoice-share-btn"
            style={styles.actionBtn}
            onPress={share}
            disabled={busy}
            activeOpacity={0.85}
          >
            <Feather name="share-2" size={18} color={colors.onBrandPrimary} />
            <Text style={styles.actionBtnText}>Share</Text>
          </TouchableOpacity>
          {!isPaid ? (
            <TouchableOpacity
              testID="invoice-mark-paid-btn"
              style={[styles.actionBtn, { backgroundColor: colors.surfaceSecondary, borderWidth: 1, borderColor: colors.brand }]}
              onPress={openPay}
              disabled={busy}
            >
              <Feather name="check-circle" size={18} color={colors.brand} />
              <Text style={[styles.actionBtnText, { color: colors.brand }]}>Record Payment</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      ) : null}

      {/* Actions modal */}
      <Modal visible={showActions} transparent animationType="fade" onRequestClose={() => setShowActions(false)}>
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => setShowActions(false)}>
          <View style={styles.actionsSheet}>
            <TouchableOpacity testID="invoice-duplicate" style={styles.actionRow} onPress={duplicate}>
              <Feather name="copy" size={18} color={colors.onSurface} />
              <Text style={styles.actionRowText}>Duplicate</Text>
            </TouchableOpacity>
            {!isVoid && !isPaid ? (
              <TouchableOpacity testID="invoice-void" style={styles.actionRow} onPress={voidInvoice}>
                <Feather name="x-circle" size={18} color={colors.error} />
                <Text style={[styles.actionRowText, { color: colors.error }]}>Void invoice</Text>
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity style={[styles.actionRow, { justifyContent: "center" }]} onPress={() => setShowActions(false)}>
              <Text style={styles.actionRowText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Payment modal */}
      <Modal visible={showPayModal} transparent animationType="slide" onRequestClose={() => setShowPayModal(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.payCard}>
            <View style={styles.payHeader}>
              <Text style={styles.payTitle}>Record payment</Text>
              <TouchableOpacity onPress={() => setShowPayModal(false)}>
                <Feather name="x" size={22} color={colors.muted} />
              </TouchableOpacity>
            </View>
            <Text style={styles.muted}>Balance due: {formatMoney(balance, invoice.currency)}</Text>
            <Input
              testID="pay-amount-input"
              label="Amount received"
              keyboardType="decimal-pad"
              value={payAmount}
              onChangeText={setPayAmount}
            />
            <Button testID="pay-submit" title="Save Payment" loading={busy} onPress={recordPayment} />
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

function TotalRow({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <View style={styles.totalRow}>
      <Text style={[styles.totalLabel, bold && { fontWeight: "600", color: colors.onSurface }]}>{label}</Text>
      <Text style={[styles.totalValue, bold && { fontSize: 20, color: colors.brand, fontWeight: "600" }]}>{value}</Text>
    </View>
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
  topbarTitle: { fontSize: typography.lg, fontWeight: "500", color: colors.onSurface },
  scroll: { padding: spacing.lg },
  statusRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: spacing.lg },
  metaText: { color: colors.muted, fontSize: typography.base },
  amountCard: {
    padding: spacing.xl,
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    marginBottom: spacing.lg,
  },
  amountLabel: { fontSize: 11, color: colors.muted, textTransform: "uppercase", letterSpacing: 0.5, fontWeight: "500" },
  amountValue: { fontSize: 44, fontWeight: "600", color: colors.onSurface, letterSpacing: -1.5, marginTop: 4 },
  amountPaid: { fontSize: typography.base, color: colors.brand, marginTop: spacing.sm, fontWeight: "500" },
  balance: { fontSize: typography.base, color: colors.error, marginTop: 2, fontWeight: "500" },
  section: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  sectionLabel: { fontSize: 11, fontWeight: "500", color: colors.muted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: spacing.sm },
  customerName: { fontSize: typography.lg, fontWeight: "500", color: colors.onSurface },
  muted: { fontSize: typography.base, color: colors.muted, marginTop: 2 },
  lineItem: {
    flexDirection: "row",
    paddingVertical: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.divider,
  },
  lineName: { fontSize: typography.lg, fontWeight: "500", color: colors.onSurface },
  lineTotal: { fontSize: typography.lg, fontWeight: "500", color: colors.onSurface, marginLeft: spacing.md },
  totalsBlock: { marginTop: spacing.md, paddingTop: spacing.md, borderTopWidth: 1, borderTopColor: colors.divider },
  totalRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 6 },
  totalLabel: { color: colors.muted, fontSize: typography.base },
  totalValue: { color: colors.onSurface, fontSize: typography.base },
  totalDivider: { height: 2, backgroundColor: colors.onSurface, marginVertical: spacing.sm },
  payLinkCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: colors.brandTertiary,
    padding: spacing.lg,
    borderRadius: radius.md,
    marginBottom: spacing.md,
  },
  payLinkText: { color: colors.brand, fontWeight: "500", fontSize: typography.base },
  notes: { color: colors.onSurface, fontSize: typography.base, lineHeight: 22 },
  terms: { color: colors.muted, fontSize: typography.sm, lineHeight: 20 },
  actionBar: {
    flexDirection: "row",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: Platform.OS === "ios" ? spacing.md : spacing.lg,
    borderTopWidth: 1,
    borderTopColor: colors.divider,
    backgroundColor: colors.surfaceSecondary,
  },
  actionBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    backgroundColor: colors.brand,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    minHeight: 48,
  },
  actionBtnText: { color: colors.onBrandPrimary, fontWeight: "500", fontSize: typography.base },
  modalOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" },
  actionsSheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    padding: spacing.md,
    paddingBottom: spacing.xxxl,
  },
  actionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    padding: spacing.lg,
    borderRadius: radius.md,
  },
  actionRowText: { color: colors.onSurface, fontSize: typography.lg, fontWeight: "500" },
  payCard: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    padding: spacing.lg,
    paddingBottom: spacing.xxxl,
  },
  payHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: spacing.md,
  },
  payTitle: { fontSize: 20, fontWeight: "600", color: colors.onSurface },
});
