import React from "react";
import { StyleSheet, Text, View } from "react-native";

import { radius, spacing, statusColors, typography } from "@/src/lib/theme";
import type { InvoiceStatus } from "@/src/lib/types";

export function StatusPill({ status, testID }: { status: InvoiceStatus; testID?: string }) {
  const s = statusColors[status] || statusColors.DRAFT;
  return (
    <View testID={testID} style={[styles.pill, { backgroundColor: s.bg }]}>
      <Text style={[styles.text, { color: s.fg }]}>{s.label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
    borderRadius: radius.pill,
    alignSelf: "flex-start",
  },
  text: {
    fontSize: typography.sm,
    fontWeight: typography.weightMedium,
  },
});
