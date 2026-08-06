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
import type { CatalogItem, Customer, Estimate, LineItemDto } from "@/src/lib/types";

export default function NewEstimate() {
  const router = useRouter();
  const { business } = useAuth();
  const currency = business?.currency || "USD";

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
  const [terms, setTerms] = useState("");
  const [issueDate, setIssueDate] = useState<string>("");
  const [expiryDate, setExpiryDate] = useState<string>("");
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
      const est = await api.post<Estimate>("/estimates", {
        customer_id: customerId,
        line_items: validLines,
        notes: notes || null,
        terms: terms || null,
        issue_date: issueDate || undefined,
        expiry_date: expiryDate || undefined,
      });
      router.replace({ pathname: "/estimates/[id]", params: { id: est.id } });
    } catch (e: unknown) {
      const err = e as Error;
      setSaveErr(err.message || "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <View style={styles.topbar}>
        <TouchableOpacity testID="new-estimate-back" onPress={() => router.back()}>
          <Feather name="x" size={22} color={colors.onSurface} />
        </TouchableOpacity>
        <Text style={styles.topbarTitle}>New Estimate</Text>
        <View style={{ width: 24 }} />
      </View>

      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={[styles.scroll, webContent]} keyboardShouldPersistTaps="handled">
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
                <DateField testID="estimate-issue-date" label="Issue date" value={issueDate} onChange={setIssueDate} placeholder="auto" maximumDate={expiryDate ? new Date(expiryDate) : undefined} />
              </View>
              <View style={{ flex: 1 }}>
                <DateField testID="estimate-expiry-date" label="Expiry date" value={expiryDate} onChange={setExpiryDate} placeholder="optional" minimumDate={issueDate ? new Date(issueDate) : undefined} />
              </View>
            </View>
            <Input testID="estimate-notes" label="Notes" multiline value={notes} onChangeText={setNotes} />
            <Input testID="estimate-terms" label="Terms" multiline value={terms} onChangeText={setTerms} />
          </Card>

          <View style={{ height: 100 }} />
        </ScrollView>

        <View style={styles.bottomBar}>
          <View style={{ flex: 1 }}>
            <Text style={styles.bottomBarLabel}>Total</Text>
            <Text style={styles.bottomBarTotal}>{formatMoney(totals.total, currency)}</Text>
          </View>
          {saveErr ? <Text style={[styles.err, { position: "absolute", top: -22, left: spacing.lg, right: spacing.lg }]}>{saveErr}</Text> : null}
          <Button testID="save-estimate-btn" title="Save & Preview" loading={saving} onPress={save} />
        </View>
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
        onSaved={(c) => {
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
  scroll: { padding: spacing.lg, paddingBottom: 40 },
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
  err: { color: colors.error, fontSize: typography.base, marginBottom: spacing.md },
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
