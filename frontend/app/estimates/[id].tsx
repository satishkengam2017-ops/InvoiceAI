import { Feather } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as MailComposer from "expo-mail-composer";
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

import { StatusPill } from "@/src/components/StatusPill";
import { useAuth } from "@/src/context/AuthContext";
import { api } from "@/src/lib/api";
import { confirmAsync } from "@/src/lib/confirm";
import { estimateHtml, generateEstimatePdfFile } from "@/src/lib/estimatePdf";
import { formatMoney } from "@/src/lib/money";
import { colors, radius, spacing, typography, webContent } from "@/src/lib/theme";
import type { Business, Estimate, Invoice } from "@/src/lib/types";

export default function EstimateDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { business } = useAuth();

  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [showActions, setShowActions] = useState(false);
  const [convertErr, setConvertErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const est = await api.get<Estimate>(`/estimates/${id}`);
      setEstimate(est);
    } catch (e) {
      Alert.alert("Error", e instanceof Error ? e.message : "Failed to load");
      router.back();
    } finally {
      setLoading(false);
    }
  }, [id, router]);

  useEffect(() => { load(); }, [load]);

  if (loading || !estimate || !business) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <ActivityIndicator style={{ marginTop: 60 }} size="large" color={colors.brand} />
      </SafeAreaView>
    );
  }

  const isDraft = estimate.status === "DRAFT";
  const isSent = estimate.status === "SENT";
  const isDeclined = estimate.status === "DECLINED";
  const isConverted = estimate.status === "CONVERTED";
  const canConvert = !isDeclined && !isConverted;

  const openHtmlInNewTab = (html: string, autoPrint: boolean) => {
    if (typeof window === "undefined") return false;
    const win = window.open("", "_blank");
    if (!win) {
      Alert.alert("Popup blocked", "Please allow popups for this site, then try again.");
      return false;
    }
    win.document.open();
    win.document.write(html);
    win.document.close();
    if (autoPrint) {
      setTimeout(() => { try { win.focus(); win.print(); } catch { /* ignore */ } }, 400);
    }
    return true;
  };

  const markSentIfDraft = async () => {
    if (estimate?.status === "DRAFT") {
      try {
        const updated = await api.post<Estimate>(`/estimates/${estimate.id}/send`, {});
        setEstimate(updated);
      } catch { /* ignore */ }
    }
  };

  const sendEmail = async () => {
    if (!estimate || !business) return;
    setBusy(true);
    try {
      const subject = `Estimate ${estimate.number} from ${business.name}`;
      const customerName = estimate.customer?.name ?? "there";
      const total = formatMoney(estimate.total_cents, estimate.currency);
      const body = `Hi ${customerName}, please find attached Estimate ${estimate.number} for ${total}. Thank you!`;
      const recipientEmail = estimate.customer?.email ?? undefined;

      if (Platform.OS === "web") {
        const { url } = await api.post<{ url: string }>(`/estimates/${estimate.id}/email-pdf`, {
          html: estimateHtml(estimate, business as Business),
        });
        const webBody = `Hi ${customerName},\n\nPlease find your estimate here:\n${url}\n\nTotal: ${total}. Thank you!`;
        const encodedSubject = encodeURIComponent(subject);
        const encodedBody = encodeURIComponent(webBody);
        await Linking.openURL(`mailto:${recipientEmail ?? ""}?subject=${encodedSubject}&body=${encodedBody}`);
      } else {
        const { uri } = await generateEstimatePdfFile(estimate, business as Business);
        const canCompose = await MailComposer.isAvailableAsync();
        if (!canCompose) {
          Alert.alert("Email unavailable", "No mail app is configured on this device.");
          return;
        }
        await MailComposer.composeAsync({
          recipients: recipientEmail ? [recipientEmail] : [],
          subject,
          body,
          attachments: [uri],
        });
      }
      await markSentIfDraft();
    } catch (e) {
      Alert.alert("Send failed", e instanceof Error ? e.message : "Unknown error");
    } finally {
      setBusy(false);
    }
  };

  const downloadPdf = async () => {
    if (!estimate) return;
    setBusy(true);
    try {
      if (Platform.OS === "web") {
        openHtmlInNewTab(estimateHtml(estimate, business as Business), true);
      } else {
        const { uri, fileName } = await generateEstimatePdfFile(estimate, business as Business);
        const canShare = await Sharing.isAvailableAsync();
        if (!canShare) {
          Alert.alert("Download unavailable", "PDF download isn't available on this device.");
          return;
        }
        await Sharing.shareAsync(uri, {
          mimeType: "application/pdf",
          dialogTitle: `Save ${fileName}`,
          UTI: "com.adobe.pdf",
        });
      }
    } catch (e) {
      Alert.alert("Download failed", e instanceof Error ? e.message : "Unknown error");
    } finally {
      setBusy(false);
    }
  };

  const acceptEstimate = async () => {
    setBusy(true);
    try {
      const updated = await api.post<Estimate>(`/estimates/${estimate.id}/accept`, {});
      setEstimate(updated);
    } catch (e) {
      Alert.alert("Error", e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  const declineEstimate = async () => {
    const ok = await confirmAsync("Decline estimate?", "This can't be undone.");
    if (!ok) return;
    setBusy(true);
    try {
      const updated = await api.post<Estimate>(`/estimates/${estimate.id}/decline`, {});
      setEstimate(updated);
    } catch (e) {
      Alert.alert("Error", e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  const convertToInvoice = async () => {
    setConvertErr(null);
    setBusy(true);
    try {
      const inv = await api.post<Invoice>(`/estimates/${estimate.id}/convert`, {});
      router.replace({ pathname: "/invoices/[id]", params: { id: inv.id } });
    } catch (e: unknown) {
      const err = e as Error & { body?: { detail?: { error?: string; message?: string } } };
      if (err.body?.detail?.error === "PLAN_LIMIT_REACHED") {
        setConvertErr(err.body.detail.message || "Plan limit reached. Upgrade in Settings.");
      } else {
        Alert.alert("Error", err.message || "Failed to convert");
      }
    } finally {
      setBusy(false);
    }
  };

  const duplicate = async () => {
    setBusy(true);
    try {
      const newEst = await api.post<Estimate>(`/estimates/${estimate.id}/duplicate`, {});
      setShowActions(false);
      router.replace({ pathname: "/estimates/[id]", params: { id: newEst.id } });
    } catch (e) {
      Alert.alert("Error", e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  const deleteDraft = async () => {
    const ok = await confirmAsync("Delete estimate?", "This can't be undone.");
    if (!ok) return;
    setBusy(true);
    try {
      await api.del(`/estimates/${estimate.id}`);
      setShowActions(false);
      router.back();
    } catch (e) {
      Alert.alert("Error", e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <View style={styles.topbar}>
        <TouchableOpacity testID="estimate-back" onPress={() => router.back()}>
          <Feather name="chevron-left" size={24} color={colors.onSurface} />
        </TouchableOpacity>
        <Text style={styles.topbarTitle}>{estimate.number}</Text>
        <TouchableOpacity testID="estimate-more" onPress={() => setShowActions(true)}>
          <Feather name="more-horizontal" size={22} color={colors.onSurface} />
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={[styles.scroll, Platform.OS === "web" && styles.scrollWeb]}>
        <View style={paperStyle}>
          {/* Status row */}
          <View style={styles.statusRow}>
            <StatusPill status={estimate.status} testID="estimate-status" />
            <Text style={styles.metaText}>{estimate.expiry_date ? `Expires ${estimate.expiry_date}` : "No expiry"}</Text>
          </View>

          {/* Amount hero */}
          <View style={styles.amountCard}>
            <Text style={styles.amountLabel}>Total</Text>
            <Text testID="estimate-total" style={styles.amountValue}>{formatMoney(estimate.total_cents, estimate.currency)}</Text>
            {isConverted && estimate.converted_invoice_id ? (
              <TouchableOpacity
                testID="estimate-view-invoice"
                onPress={() => router.push({ pathname: "/invoices/[id]", params: { id: estimate.converted_invoice_id as string } })}
              >
                <Text style={[styles.link, { marginTop: spacing.sm }]}>View converted invoice →</Text>
              </TouchableOpacity>
            ) : null}
          </View>

          {/* Prepared for */}
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>Prepared for</Text>
            <Text style={styles.customerName}>{estimate.customer?.name}</Text>
            {estimate.customer?.company ? <Text style={styles.muted}>{estimate.customer.company}</Text> : null}
            {estimate.customer?.email ? <Text style={styles.muted}>{estimate.customer.email}</Text> : null}
          </View>

          {/* Line items */}
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>Line items</Text>
            {estimate.line_items.map((li, idx) => (
              <View key={idx} style={styles.lineItem}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.lineName}>{li.name}</Text>
                  {li.description ? <Text style={styles.muted}>{li.description}</Text> : null}
                  <Text style={styles.muted}>
                    {li.quantity} × {formatMoney(li.unit_price_cents, estimate.currency)}
                    {li.tax_percent ? ` · ${li.tax_percent}% tax` : ""}
                  </Text>
                </View>
                <Text style={styles.lineTotal}>
                  {formatMoney(Math.round(li.quantity * li.unit_price_cents * (1 + (li.tax_percent || 0) / 100)), estimate.currency)}
                </Text>
              </View>
            ))}

            <View style={styles.totalsBlock}>
              <TotalRow label="Subtotal" value={formatMoney(estimate.subtotal_cents, estimate.currency)} />
              {estimate.tax_total_cents ? <TotalRow label="Tax" value={formatMoney(estimate.tax_total_cents, estimate.currency)} /> : null}
              {estimate.discount_cents ? <TotalRow label="Discount" value={`- ${formatMoney(estimate.discount_cents, estimate.currency)}`} /> : null}
              <View style={styles.totalDivider} />
              <TotalRow label="Total" value={formatMoney(estimate.total_cents, estimate.currency)} bold />
            </View>
          </View>

          {estimate.notes ? (
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>Notes</Text>
              <Text style={styles.notes}>{estimate.notes}</Text>
            </View>
          ) : null}

          {estimate.terms ? (
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>Terms</Text>
              <Text style={styles.terms}>{estimate.terms}</Text>
            </View>
          ) : null}
        </View>
        <View style={{ height: Platform.OS === "web" ? 40 : 160 }} />
      </ScrollView>

      {/* Action bar */}
      <View style={styles.actionBar}>
        <View style={[styles.actionBarInner, webContent]}>
          <TouchableOpacity
            testID="estimate-download-pdf-btn"
            style={[styles.actionBtn, styles.actionBtnOutline]}
            onPress={downloadPdf}
            disabled={busy}
            activeOpacity={0.85}
          >
            <Feather name="download" size={20} color={colors.brand} />
            <Text style={[styles.actionBtnText, { color: colors.brand }]}>Download PDF</Text>
          </TouchableOpacity>
          {isSent ? (
            <>
              <TouchableOpacity
                testID="estimate-decline-btn"
                style={[styles.actionBtn, styles.actionBtnOutline, { borderColor: colors.error }]}
                onPress={declineEstimate}
                disabled={busy}
              >
                <Feather name="x" size={20} color={colors.error} />
                <Text style={[styles.actionBtnText, { color: colors.error }]}>Decline</Text>
              </TouchableOpacity>
              <TouchableOpacity
                testID="estimate-accept-btn"
                style={styles.actionBtn}
                onPress={acceptEstimate}
                disabled={busy}
              >
                <Feather name="check" size={20} color={colors.onBrandPrimary} />
                <Text style={styles.actionBtnText}>Accept</Text>
              </TouchableOpacity>
            </>
          ) : (
            <TouchableOpacity
              testID="estimate-send-email-btn"
              style={styles.actionBtn}
              onPress={sendEmail}
              disabled={busy}
              activeOpacity={0.85}
            >
              <Feather name="mail" size={20} color={colors.onBrandPrimary} />
              <Text style={styles.actionBtnText}>Send Email</Text>
            </TouchableOpacity>
          )}
        </View>
        {canConvert ? (
          <View style={[webContent, { marginTop: spacing.sm }]}>
            {convertErr ? <Text style={styles.err}>{convertErr}</Text> : null}
            <TouchableOpacity
              testID="estimate-convert-btn"
              style={styles.convertBtn}
              onPress={convertToInvoice}
              disabled={busy}
              activeOpacity={0.85}
            >
              <Feather name="repeat" size={18} color={colors.brand} />
              <Text style={styles.convertBtnText}>Convert to Invoice</Text>
            </TouchableOpacity>
          </View>
        ) : null}
      </View>

      {/* Actions modal */}
      <Modal visible={showActions} transparent animationType="fade" onRequestClose={() => setShowActions(false)}>
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => setShowActions(false)}>
          <View style={styles.actionsSheet}>
            <TouchableOpacity testID="estimate-duplicate" style={styles.actionRow} onPress={duplicate}>
              <Feather name="copy" size={18} color={colors.onSurface} />
              <Text style={styles.actionRowText}>Duplicate</Text>
            </TouchableOpacity>
            {isDraft ? (
              <TouchableOpacity testID="estimate-delete" style={styles.actionRow} onPress={deleteDraft}>
                <Feather name="trash-2" size={18} color={colors.error} />
                <Text style={[styles.actionRowText, { color: colors.error }]}>Delete estimate</Text>
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity style={[styles.actionRow, { justifyContent: "center" }]} onPress={() => setShowActions(false)}>
              <Text style={styles.actionRowText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
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

const paperStyle =
  Platform.OS === "web"
    ? ({
        width: "100%",
        maxWidth: 640,
        alignSelf: "center",
        backgroundColor: colors.surfaceSecondary,
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: 12,
        paddingHorizontal: 36,
        paddingVertical: 40,
        minHeight: 900,
        boxShadow: "0 1px 2px rgba(17,17,16,0.05), 0 10px 30px -8px rgba(17,17,16,0.10)",
      } as object)
    : undefined;

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.surface },
  scrollWeb: { paddingVertical: spacing.xxl },
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
  link: { color: colors.brand, fontWeight: "500", fontSize: typography.base },
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
  notes: { color: colors.onSurface, fontSize: typography.base, lineHeight: 22 },
  terms: { color: colors.muted, fontSize: typography.sm, lineHeight: 20 },
  actionBar: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: Platform.OS === "ios" ? spacing.md : spacing.lg,
    borderTopWidth: 1,
    borderTopColor: colors.divider,
    backgroundColor: colors.surfaceSecondary,
  },
  actionBarInner: {
    flexDirection: "row",
    gap: spacing.sm,
  },
  actionBtn: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    backgroundColor: colors.brand,
    paddingVertical: spacing.sm,
    paddingHorizontal: 4,
    borderRadius: radius.md,
    minHeight: 56,
  },
  actionBtnOutline: {
    backgroundColor: colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: colors.brand,
  },
  actionBtnText: {
    color: colors.onBrandPrimary,
    fontWeight: "500",
    fontSize: 12,
    textAlign: "center",
  },
  convertBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    height: 44,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.brand,
    backgroundColor: colors.brandTertiary,
  },
  convertBtnText: { color: colors.brand, fontWeight: "500", fontSize: typography.base },
  err: { color: colors.error, fontSize: typography.base, marginBottom: spacing.sm, textAlign: "center" },
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
});
