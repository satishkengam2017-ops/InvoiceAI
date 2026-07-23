import React from "react";
import { StyleSheet, Text, View, ViewStyle } from "react-native";

import { colors, radius, spacing } from "@/src/lib/theme";

export function Card({ children, style, testID }: { children: React.ReactNode; style?: ViewStyle; testID?: string }) {
  return (
    <View testID={testID} style={[styles.card, style]}>
      {children}
    </View>
  );
}

export function EmptyState({
  title,
  subtitle,
  action,
  testID,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  testID?: string;
}) {
  return (
    <View testID={testID} style={styles.empty}>
      <Text style={styles.emptyTitle}>{title}</Text>
      {subtitle ? <Text style={styles.emptySubtitle}>{subtitle}</Text> : null}
      {action ? <View style={{ marginTop: spacing.lg }}>{action}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.lg,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  empty: {
    padding: spacing.xl,
    alignItems: "center",
    justifyContent: "center",
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: "500",
    color: colors.onSurface,
    marginBottom: spacing.xs,
    textAlign: "center",
  },
  emptySubtitle: {
    fontSize: 14,
    color: colors.muted,
    textAlign: "center",
  },
});
