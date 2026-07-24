// Native implementation (iOS/Android): tapping the field opens the OS date
// picker. Android shows its native dialog directly. iOS's "inline" calendar
// has no popover mode, so it's wrapped in our own bottom-sheet Modal here —
// rendering it straight in the layout (no Modal) makes it a permanently-open
// full calendar that overlaps surrounding content.
// Metro resolves DateField.web.tsx instead of this file for web builds.
import DateTimePicker from "@react-native-community/datetimepicker";
import React, { useState } from "react";
import { Modal, Platform, StyleSheet, Text, TouchableOpacity, View } from "react-native";

import { colors, radius, spacing, typography } from "@/src/lib/theme";

type Props = {
  label?: string;
  value: string; // "" or "YYYY-MM-DD"
  onChange: (value: string) => void;
  placeholder?: string;
  testID?: string;
  minimumDate?: Date;
  maximumDate?: Date;
};

function toDate(value: string): Date {
  if (!value) return new Date();
  const [y, m, d] = value.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

function toIso(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function DateField({ label, value, onChange, placeholder, testID, minimumDate, maximumDate }: Props) {
  const [showPicker, setShowPicker] = useState(false);
  const [draft, setDraft] = useState(() => toDate(value));

  const open = () => {
    setDraft(toDate(value));
    setShowPicker(true);
  };

  const field = (
    <View style={styles.wrap}>
      {label ? <Text style={styles.label}>{label}</Text> : null}
      <TouchableOpacity testID={testID} style={styles.input} onPress={open} activeOpacity={0.7}>
        <Text style={value ? styles.valueText : styles.placeholderText}>{value || placeholder || "Select date"}</Text>
      </TouchableOpacity>
    </View>
  );

  if (Platform.OS === "android") {
    return (
      <>
        {field}
        {showPicker ? (
          <DateTimePicker
            value={draft}
            mode="date"
            display="default"
            minimumDate={minimumDate}
            maximumDate={maximumDate}
            onChange={(event, date) => {
              setShowPicker(false);
              if (event.type === "set" && date) onChange(toIso(date));
            }}
          />
        ) : null}
      </>
    );
  }

  // iOS: inline calendar inside a bottom-sheet modal with Cancel/Done.
  return (
    <>
      {field}
      <Modal visible={showPicker} transparent animationType="slide" onRequestClose={() => setShowPicker(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.sheet}>
            <View style={styles.sheetHeader}>
              <TouchableOpacity onPress={() => setShowPicker(false)}>
                <Text style={styles.sheetCancel}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => {
                  onChange(toIso(draft));
                  setShowPicker(false);
                }}
              >
                <Text style={styles.sheetDone}>Done</Text>
              </TouchableOpacity>
            </View>
            <DateTimePicker
              value={draft}
              mode="date"
              display="inline"
              minimumDate={minimumDate}
              maximumDate={maximumDate}
              onChange={(_event, date) => {
                if (date) setDraft(date);
              }}
            />
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  wrap: { marginBottom: spacing.md },
  label: {
    fontSize: typography.sm,
    color: colors.onSurfaceTertiary,
    marginBottom: spacing.xs,
    fontWeight: typography.weightMedium,
  },
  input: {
    minHeight: 48,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.lg,
    justifyContent: "center",
  },
  valueText: { fontSize: typography.lg, color: colors.onSurface },
  placeholderText: { fontSize: typography.lg, color: colors.muted },
  modalOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" },
  sheet: {
    backgroundColor: colors.surfaceSecondary,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    paddingBottom: spacing.xl,
  },
  sheetHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  sheetCancel: { color: colors.muted, fontSize: typography.lg },
  sheetDone: { color: colors.brand, fontSize: typography.lg, fontWeight: "600" },
});
