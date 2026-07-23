import React from "react";
import { StyleSheet, Text, TextInput, TextInputProps, View } from "react-native";

import { colors, radius, spacing, typography } from "@/src/lib/theme";

type Props = TextInputProps & {
  label?: string;
  hint?: string;
  error?: string;
  testID?: string;
};

export function Input({ label, hint, error, style, testID, ...rest }: Props) {
  return (
    <View style={styles.wrap}>
      {label ? <Text style={styles.label}>{label}</Text> : null}
      <TextInput
        {...rest}
        testID={testID}
        placeholderTextColor={colors.muted}
        style={[styles.input, error ? styles.inputError : null, style]}
      />
      {error ? <Text style={styles.error}>{error}</Text> : hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
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
    paddingVertical: spacing.md,
    fontSize: typography.lg,
    color: colors.onSurface,
  },
  inputError: { borderColor: colors.error },
  hint: { fontSize: typography.sm, color: colors.muted, marginTop: spacing.xs },
  error: { fontSize: typography.sm, color: colors.error, marginTop: spacing.xs },
});
