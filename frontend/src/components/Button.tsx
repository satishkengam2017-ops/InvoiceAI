import React from "react";
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  ViewStyle,
} from "react-native";

import { colors, radius, spacing, typography } from "@/src/lib/theme";

type Variant = "primary" | "secondary" | "ghost" | "danger";

type Props = {
  title: string;
  onPress?: () => void;
  variant?: Variant;
  disabled?: boolean;
  loading?: boolean;
  style?: ViewStyle;
  testID?: string;
  icon?: React.ReactNode;
};

export function Button({ title, onPress, variant = "primary", disabled, loading, style, testID, icon }: Props) {
  const isDisabled = disabled || loading;

  const containerStyle: ViewStyle[] = [styles.base];
  const textColor = { color: colors.onBrandPrimary } as { color: string };

  if (variant === "primary") {
    containerStyle.push({ backgroundColor: colors.brandPrimary });
    textColor.color = colors.onBrandPrimary;
  } else if (variant === "secondary") {
    containerStyle.push({ backgroundColor: colors.surfaceSecondary, borderWidth: 1, borderColor: colors.border });
    textColor.color = colors.onSurface;
  } else if (variant === "ghost") {
    containerStyle.push({ backgroundColor: "transparent" });
    textColor.color = colors.brandPrimary;
  } else if (variant === "danger") {
    containerStyle.push({ backgroundColor: colors.error });
    textColor.color = colors.onError;
  }

  if (isDisabled) containerStyle.push({ opacity: 0.5 });
  if (style) containerStyle.push(style);

  return (
    <TouchableOpacity
      testID={testID}
      onPress={onPress}
      disabled={isDisabled}
      activeOpacity={0.85}
      style={containerStyle}
    >
      {loading ? (
        <ActivityIndicator color={textColor.color} />
      ) : (
        <>
          {icon}
          <Text style={[styles.text, textColor]}>{title}</Text>
        </>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: 48,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: spacing.sm,
  },
  text: {
    fontSize: typography.lg,
    fontWeight: typography.weightMedium,
  },
});
