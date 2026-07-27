// Web implementation: native <input type="date"> — every modern browser
// renders its own calendar affordance for this, no extra UI needed.
// (Split from DateField.tsx because @react-native-community/datetimepicker
// has no web build; Metro resolves this file for web automatically.)
import React from "react";
import { StyleSheet, Text, View } from "react-native";

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

export function DateField({ label, value, onChange, testID }: Props) {
  return (
    // minWidth: 0 lets this flex item actually shrink to its allotted
    // width — an empty native <input type="date"> has a wider intrinsic
    // content width in mobile Safari (it shows all placeholder segments,
    // e.g. mm/dd/yyyy) than a filled one, and flex items don't shrink below
    // their content's intrinsic width by default, so without this the
    // empty field overflows past its side-by-side sibling's row.
    <View style={[styles.wrap, { minWidth: 0 }]}>
      {label ? <Text style={styles.label}>{label}</Text> : null}
      <input
        data-testid={testID}
        type="date"
        value={value}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
        style={webInputStyle}
      />
    </View>
  );
}

const webInputStyle: React.CSSProperties = {
  minHeight: 48,
  height: 48,
  borderRadius: radius.md,
  backgroundColor: colors.surfaceSecondary,
  border: `1px solid ${colors.border}`,
  paddingLeft: spacing.lg,
  paddingRight: spacing.lg,
  fontSize: typography.lg,
  color: colors.onSurface,
  fontFamily: "inherit",
  width: "100%",
  minWidth: 0,
  boxSizing: "border-box",
};

const styles = StyleSheet.create({
  wrap: { marginBottom: spacing.md },
  label: {
    fontSize: typography.sm,
    color: colors.onSurfaceTertiary,
    marginBottom: spacing.xs,
    fontWeight: typography.weightMedium,
  },
});
