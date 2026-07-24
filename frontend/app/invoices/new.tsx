import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import React, { useEffect, useMemo, useState } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AddCustomerModal } from "@/src/components/AddCustomerModal";
import { Button } from "@/src/components/Button";
import { Card } from "@/src/components/Card";
import { DateField } from "@/src/components/DateField";
import { Input } from "@/src/components/Input";
import { useAuth } from "@/src/context/AuthContext";
import { api } from "@/src/lib/api";
import { computeTotals, formatMoney, parseCents } from "@/src/lib/money";
import { colors, radius, spacing, typography, webContent } from "@/src/lib/theme";
import type { CatalogItem, Customer, Invoice, LineItemDto } from "@/src/lib/types";

type Mode = "AI" | "MANUAL";

export default function NewInvoice() {
  const router = useRouter();
  const { business } = useAuth();
  const currency = business?.currency || "USD";

  const [mode, setMode] = useState<Mode>("AI");
  const [aiText, setAiText] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [aiWarnings, setAiWarnings] = useState<string[]>([]);
  const [aiError, setAiError] = useState<string | null>(null);

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [showPickCustomer, setShowPickCustomer] = useState(false);
  const [showAddCustomer, setShowAddCustomer] = useState(false);
  const [showPickCatalog, setShowPickCatalog] = useState(false);
  const [lineItems, setLineItems] = useState<LineItemDto[]>([
    { name: "", quantity: 1, unit_price_cents: 0, tax_percent: 0 },
  ]);
  const [notes, setNotes] = useState("");
  const [stripeUrl, setStripeUrl] = useState(business?.stripe_payment_url_default || "");
  const [dueDate, setDueDate] = useState<string>("");
  const [issueDate, setIssueDate] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  useEffect(() => {
    api.get<Customer[]>("/customers").then(setCustomers).catch(() => {});
    api.get<CatalogItem[]>("/catalog").then(setCatalog).catch(() => {});
  }, []);

  const totals = useMemo(() => computeTotals(lineItems), [lineItems]);
  const selectedCustomer = customers.find((c) => c.id === customerId);

  const setLine = (idx: number, patch: Partial<LineItemDto>) => {
    setLineItems((prev) => prev.map((li, i) => (i === idx ? { ...li, ...patch } : li)));
  };
  const addLine = () => setLineItems((p) => [...p, { name: "", quantity: 1, unit_price_cents: 0, tax_percent: 0 }]);
  const removeLine = (idx: number) => setLineItems((p) => p.filter((_, i) => i !== idx));

  const runAI = async () => {
    if (!aiText.trim()) return;
    setAiLoading(true); setAiWarnings([]); setAiError(null);
    try {
      const res = await api.post<{ draft: {
        customer_name: string;
        customer_is_new?: boolean;
        line_items: LineItemDto[];
        issue_date?: string;
        due_date?: string;
        notes?: string;
        warnings?: string[];
      } }>("/ai/extract-invoice", { text: aiText });
      const d = res.draft;
      // Match customer by name (case-insensitive contains)
      const match = customers.find((c) => c.name.toLowerCase() === d.customer_name.toLowerCase())
        || customers.find((c) => c.name.toLowerCase().includes(d.customer_name.toLowerCase()));
      if (match) setCustomerId(match.id);
      setLineItems(d.line_items?.length ? d.line_items.map((l) => ({
        name: l.name,
        description: l.description || undefined,
        quantity: Number(l.quantity) || 1,
        unit_price_cents: Number(l.unit_price_cents) || 0,
        tax_percent: Number(l.tax_percent) || 0,
      })) : [{ name: "", quantity: 1, unit_price_cents: 0, tax_percent: 0 }]);
      if (d.issue_date) setIssueDate(d.issue_date);
      if (d.due_date) setDueDate(d.due_date);
      if (d.notes) setNotes(d.notes);
      setAiWarnings(d.warnings || []);
      if (!match) {
        setAiWarnings((w) => [`Customer "${d.customer_name}" not found — please pick or add manually.`, ...w]);
      }
      setMode("MANUAL");
    } catch (e) {
      setAiError(e instanceof Error ? e.message : "AI extraction failed");
    } finally {
      setAiLoading(false);
    }
  };

  const addFromCatalog = (item: CatalogItem) => {
    setLineItems((p) => {
      const empty = p.findIndex((li) => !li.name && !li.unit_price_cents);
      const line: LineItemDto = {
        name: item.name,
        description: item.description || undefined,
        quantity: 1,
        unit_price_cents: item.unit_price_cents,
        tax_percent: item.tax_percent || 0,
      };
      if (empty >= 0) {
        return p.map((li, i) => (i === empty ? line : li));
      }
      return [...p, line];
    });
  };

  const save = async () => {
    setSaveErr(null);
    if (!customerId) return setSaveErr("Please select a customer");
    const validLines = lineItems.filter((li) => li.name && (li.unit_price_cents > 0 || li.quantity > 0));
    if (validLines.length === 0) return setSaveErr("Add at least one line item");
    setSaving(true);
    try {
      const inv = await api.post<Invoice>("/invoices", {
        customer_id: customerId,
        line_items: validLines,
        notes: notes || null,
        stripe_payment_url: stripeUrl || null,
        issue_date: issueDate || undefined,
        due_date: dueDate || undefined,
        ai_source_text: aiText || null,
      });
      router.replace({ pathname: "/invoices/[id]", params: { id: inv.id } });
    } catch (e: unknown) {
      const err = e as Error & { body?: { detail?: { error?: string; message?: string } } };
      if (err.body?.detail?.error === "PLAN_LIMIT_REACHED") {
        setSaveErr(err.body.detail.message || "Plan limit reached. Upgrade in Settings.");
      } else {
        setSaveErr(err.message || "Failed to save");
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <View style={styles.topbar}>
        <TouchableOpacity testID="new-invoice-back" onPress={() => router.back()}>
          <Feather name="x" size={22} color={colors.onSurface} />
        </TouchableOpacity>
        <Text style={styles.topbarTitle}>New Invoice</Text>
        <View style={{ width: 24 }} />
      </View>

      {/* Mode toggle */}
      <View style={[styles.modeRow, webContent]}>
        <TouchableOpacity
          testID="mode-ai"
          onPress={() => setMode("AI")}
          style={[styles.modeChip, mode === "AI" && styles.modeChipActive]}
        >
          <Feather name="zap" size={14} color={mode === "AI" ? colors.onBrandPrimary : colors.brand} />
          <Text style={[styles.modeChipText, mode === "AI" && { color: colors.onBrandPrimary }]}>AI Draft</Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID="mode-manual"
          onPress={() => setMode("MANUAL")}
          style={[styles.modeChip, mode === "MANUAL" && styles.modeChipActive]}
        >
          <Feather name="edit-3" size={14} color={mode === "MANUAL" ? colors.onBrandPrimary : colors.brand} />
          <Text style={[styles.modeChipText, mode === "MANUAL" && { color: colors.onBrandPrimary }]}>Manual</Text>
        </TouchableOpacity>
      </View>

      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={[styles.scroll, webContent]} keyboardShouldPersistTaps="handled">
          {mode === "AI" ? (
            <>
              <Text style={styles.helper}>
                Describe the job in plain English. Include the customer, what you did, price, and when it&apos;s due. We&apos;ll draft the invoice.
              </Text>
              <View style={styles.aiBox}>
                <TextInput
                  testID="ai-text-input"
                  multiline
                  placeholder="e.g. Invoice John Smith for 3 hours of electrical work at $95/hr plus a $40 service call fee, due in 2 weeks."
                  placeholderTextColor={colors.muted}
                  style={styles.aiInput}
                  value={aiText}
                  onChangeText={setAiText}
                  textAlignVertical="top"
                />
              </View>
              {aiError ? <Text style={styles.err}>{aiError}</Text> : null}
              {!business?.has_anthropic_key ? (
                <Text style={styles.warn}>
                  Add your Anthropic API key in Settings to use AI drafting.
                </Text>
              ) : null}
              <Button
                testID="ai-generate-btn"
                title="Generate Draft"
                loading={aiLoading}
                onPress={runAI}
                disabled={!aiText.trim() || !business?.has_anthropic_key}
                icon={<Feather name="zap" size={16} color={colors.onBrandPrimary} />}
              />
              <TouchableOpacity testID="ai-switch-manual" style={{ marginTop: spacing.md }} onPress={() => setMode("MANUAL")}>
                <Text style={styles.link}>or create manually →</Text>
              </TouchableOpacity>
            </>
          ) : (
            <>
              {aiWarnings.length > 0 ? (
                <Card style={styles.warnCard}>
                  <Text style={styles.warnTitle}>Please review</Text>
                  {aiWarnings.map((w, i) => (
                    <Text key={i} style={styles.warnItem}>• {w}</Text>
                  ))}
                </Card>
              ) : null}

              {/* Customer */}
              <Card style={styles.card}>
                <Text style={styles.sectionTitle}>Customer</Text>
                {selectedCustomer ? (
                  <View style={styles.selectedCustomer}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.customerName}>{selectedCustomer.name}</Text>
                      {selectedCustomer.email ? <Text style={styles.muted}>{selectedCustomer.email}</Text> : null}
                    </View>
                    <TouchableOpacity testID="change-customer" onPress={() => setShowPickCustomer(true)}>
                      <Text style={styles.link}>Change</Text>
                    </TouchableOpacity>
                  </View>
                ) : (
                  <View style={{ flexDirection: "row", gap: spacing.sm }}>
                    <Button testID="pick-customer-btn" title="Select" variant="secondary" style={{ flex: 1 }} onPress={() => setShowPickCustomer(true)} />
                    <Button testID="new-customer-btn" title="+ New" variant="secondary" style={{ flex: 1 }} onPress={() => setShowAddCustomer(true)} />
                  </View>
                )}
              </Card>

              {/* Line items */}
              <Card style={styles.card}>
                <View style={styles.sectionRow}>
                  <Text style={styles.sectionTitle}>Line items</Text>
                  {catalog.length > 0 ? (
                    <TouchableOpacity testID="show-catalog-btn" onPress={() => setShowPickCatalog(true)}>
                      <Text style={styles.link}>From catalog</Text>
                    </TouchableOpacity>
                  ) : null}
                </View>

                {lineItems.map((li, idx) => (
                  <View key={idx} style={styles.lineItem}>
                    <View style={styles.lineHeader}>
                      <Text style={styles.lineLabel}>Item {idx + 1}</Text>
                      {lineItems.length > 1 ? (
                        <TouchableOpacity testID={`remove-line-${idx}`} onPress={() => removeLine(idx)}>
                          <Feather name="trash-2" size={16} color={colors.error} />
                        </TouchableOpacity>
                      ) : null}
                    </View>
                    <Input
                      testID={`line-name-${idx}`}
                      label="Description"
                      value={li.name}
                      onChangeText={(v) => setLine(idx, { name: v })}
                      placeholder="e.g. Electrical work"
                    />
                    <View style={{ flexDirection: "row", gap: spacing.sm }}>
                      <View style={{ flex: 1 }}>
                        <Input
                          testID={`line-qty-${idx}`}
                          label="Qty"
                          keyboardType="decimal-pad"
                          value={String(li.quantity)}
                          onChangeText={(v) => setLine(idx, { quantity: parseFloat(v) || 0 })}
                        />
                      </View>
                      <View style={{ flex: 1.2 }}>
                        <Input
                          testID={`line-price-${idx}`}
                          label="Unit price"
                          keyboardType="decimal-pad"
                          value={(li.unit_price_cents / 100).toString()}
                          onChangeText={(v) => setLine(idx, { unit_price_cents: parseCents(v) })}
                        />
                      </View>
                      <View style={{ flex: 0.8 }}>
                        <Input
                          testID={`line-tax-${idx}`}
                          label="Tax %"
                          keyboardType="decimal-pad"
                          value={String(li.tax_percent || 0)}
                          onChangeText={(v) => setLine(idx, { tax_percent: parseFloat(v) || 0 })}
                        />
                      </View>
                    </View>
                    <Text style={styles.lineTotal}>
                      Line total: {formatMoney(Math.round(li.quantity * li.unit_price_cents * (1 + (li.tax_percent || 0) / 100)), currency)}
                    </Text>
                  </View>
                ))}
                <TouchableOpacity testID="add-line-btn" style={styles.addLineBtn} onPress={addLine}>
                  <Feather name="plus-circle" size={16} color={colors.brand} />
                  <Text style={styles.link}>Add another line</Text>
                </TouchableOpacity>
              </Card>

              {/* Meta */}
              <Card style={styles.card}>
                <Text style={styles.sectionTitle}>Details</Text>
                <View style={{ flexDirection: "row", gap: spacing.md }}>
                  <View style={{ flex: 1 }}>
                    <DateField testID="invoice-issue-date" label="Issue date" value={issueDate} onChange={setIssueDate} placeholder="auto" maximumDate={dueDate ? new Date(dueDate) : undefined} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <DateField testID="invoice-due-date" label="Due date" value={dueDate} onChange={setDueDate} placeholder="auto" minimumDate={issueDate ? new Date(issueDate) : undefined} />
                  </View>
                </View>
                <Input testID="invoice-notes" label="Notes" multiline value={notes} onChangeText={setNotes} />
                <Input
                  testID="invoice-stripe-url"
                  label="Stripe payment URL (optional)"
                  autoCapitalize="none"
                  keyboardType="url"
                  value={stripeUrl}
                  onChangeText={setStripeUrl}
                  placeholder="https://buy.stripe.com/..."
                />
              </Card>

              <View style={{ height: 100 }} />
            </>
          )}
        </ScrollView>

        {mode === "MANUAL" ? (
          <View style={styles.bottomBar}>
            <View style={{ flex: 1 }}>
              <Text style={styles.bottomBarLabel}>Total</Text>
              <Text style={styles.bottomBarTotal}>{formatMoney(totals.total, currency)}</Text>
            </View>
            {saveErr ? <Text style={[styles.err, { position: "absolute", top: -22, left: spacing.lg, right: spacing.lg }]}>{saveErr}</Text> : null}
            <Button testID="save-invoice-btn" title="Save & Preview" loading={saving} onPress={save} />
          </View>
        ) : null}
      </KeyboardAvoidingView>

      {/* Customer picker */}
      <Modal visible={showPickCustomer} animationType="slide" transparent onRequestClose={() => setShowPickCustomer(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Select a customer</Text>
              <TouchableOpacity testID="pick-customer-close" onPress={() => setShowPickCustomer(false)}>
                <Feather name="x" size={22} color={colors.muted} />
              </TouchableOpacity>
            </View>
            <ScrollView style={{ maxHeight: 400 }}>
              {customers.length === 0 ? (
                <Text style={styles.muted}>No customers yet.</Text>
              ) : (
                customers.map((c) => (
                  <TouchableOpacity
                    key={c.id}
                    testID={`pick-customer-${c.id}`}
                    style={styles.pickRow}
                    onPress={() => { setCustomerId(c.id); setShowPickCustomer(false); }}
                  >
                    <Text style={styles.customerName}>{c.name}</Text>
                    {c.email ? <Text style={styles.muted}>{c.email}</Text> : null}
                  </TouchableOpacity>
                ))
              )}
            </ScrollView>
            <Button
              testID="pick-customer-new"
              title="+ Add new customer"
              variant="secondary"
              onPress={() => { setShowPickCustomer(false); setShowAddCustomer(true); }}
              style={{ marginTop: spacing.md }}
            />
          </View>
        </View>
      </Modal>

      {/* Catalog picker */}
      <Modal visible={showPickCatalog} animationType="slide" transparent onRequestClose={() => setShowPickCatalog(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Pick from catalog</Text>
              <TouchableOpacity testID="pick-catalog-close" onPress={() => setShowPickCatalog(false)}>
                <Feather name="x" size={22} color={colors.muted} />
              </TouchableOpacity>
            </View>
            <ScrollView style={{ maxHeight: 400 }}>
              {catalog.map((it) => (
                <TouchableOpacity
                  key={it.id}
                  testID={`pick-catalog-${it.id}`}
                  style={styles.pickRow}
                  onPress={() => { addFromCatalog(it); setShowPickCatalog(false); }}
                >
                  <Text style={styles.customerName}>{it.name}</Text>
                  <Text style={styles.muted}>{formatMoney(it.unit_price_cents, it.currency || "USD")}{it.unit ? ` / ${it.unit}` : ""}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        </View>
      </Modal>

      <AddCustomerModal
        visible={showAddCustomer}
        onClose={() => setShowAddCustomer(false)}
        onCreated={(c) => {
          setCustomers((prev) => [...prev, c]);
          setCustomerId(c.id);
          setShowAddCustomer(false);
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.surface },
  topbar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  topbarTitle: { fontSize: typography.lg, fontWeight: "500", color: colors.onSurface },
  modeRow: {
    flexDirection: "row",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  modeChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.brand,
    backgroundColor: colors.surface,
  },
  modeChipActive: { backgroundColor: colors.brand },
  modeChipText: { color: colors.brand, fontWeight: "500", fontSize: typography.base },
  scroll: { padding: spacing.lg, paddingBottom: 40 },
  helper: { fontSize: typography.base, color: colors.muted, marginBottom: spacing.md, lineHeight: 20 },
  aiBox: {
    backgroundColor: colors.surfaceTertiary,
    borderRadius: radius.lg,
    padding: spacing.md,
    marginBottom: spacing.md,
    minHeight: 160,
  },
  aiInput: {
    fontSize: typography.lg,
    color: colors.onSurface,
    minHeight: 140,
    lineHeight: 24,
  },
  err: { color: colors.error, fontSize: typography.base, marginBottom: spacing.md },
  warn: { color: colors.warning, fontSize: typography.sm, marginBottom: spacing.sm },
  warnCard: { marginBottom: spacing.md, borderColor: colors.warning, backgroundColor: "#FFFBEB" },
  warnTitle: { fontWeight: "500", color: colors.warning, marginBottom: spacing.sm },
  warnItem: { color: "#92400E", fontSize: typography.sm, lineHeight: 20 },
  card: { marginBottom: spacing.md },
  sectionRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: spacing.md },
  sectionTitle: { fontSize: typography.lg, fontWeight: "500", color: colors.onSurface, marginBottom: spacing.md },
  link: { color: colors.brand, fontWeight: "500", fontSize: typography.base },
  selectedCustomer: {
    flexDirection: "row",
    alignItems: "center",
    padding: spacing.md,
    backgroundColor: colors.brandTertiary,
    borderRadius: radius.md,
  },
  customerName: { fontSize: typography.lg, fontWeight: "500", color: colors.onSurface },
  muted: { fontSize: typography.base, color: colors.muted, marginTop: 2 },
  lineItem: {
    borderTopWidth: 1,
    borderTopColor: colors.divider,
    paddingTop: spacing.md,
    marginTop: spacing.sm,
  },
  lineHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: spacing.sm },
  lineLabel: { fontSize: typography.sm, color: colors.muted, textTransform: "uppercase", letterSpacing: 0.5, fontWeight: "500" },
  lineTotal: { fontSize: typography.sm, color: colors.onSurface, marginTop: spacing.xs, fontWeight: "500" },
  addLineBtn: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: spacing.md },
  bottomBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.divider,
    backgroundColor: colors.surfaceSecondary,
  },
  bottomBarLabel: { fontSize: typography.sm, color: colors.muted },
  bottomBarTotal: { fontSize: 24, fontWeight: "600", color: colors.onSurface, letterSpacing: -0.5 },
  modalOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" },
  modalCard: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    padding: spacing.lg,
    paddingBottom: spacing.xxxl,
    maxHeight: "80%",
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: spacing.lg,
  },
  modalTitle: { fontSize: 20, fontWeight: "600", color: colors.onSurface },
  pickRow: {
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceSecondary,
    marginBottom: spacing.sm,
  },
});
