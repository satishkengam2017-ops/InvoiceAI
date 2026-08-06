// Design tokens from /app/design_guidelines.json
import { Platform } from "react-native";

export const colors = {
  surface: "#F7F7F5",
  onSurface: "#111110",
  surfaceSecondary: "#FFFFFF",
  onSurfaceSecondary: "#111110",
  surfaceTertiary: "#EAEAE8",
  onSurfaceTertiary: "#3E3E3C",
  surfaceInverse: "#111110",
  onSurfaceInverse: "#FFFFFF",
  brand: "#0D683A",
  brandPrimary: "#0D683A",
  onBrandPrimary: "#FFFFFF",
  brandSecondary: "#158C4F",
  brandTertiary: "#E6F3EB",
  onBrandTertiary: "#0D683A",
  success: "#0D683A",
  onSuccess: "#FFFFFF",
  warning: "#D97706",
  onWarning: "#FFFFFF",
  error: "#DC2626",
  onError: "#FFFFFF",
  info: "#4B5563",
  onInfo: "#FFFFFF",
  border: "#E5E5E5",
  borderStrong: "#CCCCCC",
  divider: "#EAEAE8",
  muted: "#6B6B69",
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
} as const;

export const radius = {
  sm: 6,
  md: 12,
  lg: 20,
  pill: 999,
} as const;

export const typography = {
  fontFamily: undefined as string | undefined, // system font
  sm: 12,
  base: 14,
  lg: 16,
  xl: 20,
  xxl: 24,
  weightRegular: "400" as const,
  weightMedium: "500" as const,
  weightSemibold: "600" as const,
};

// Web-only: keep main content narrow and centered inside the app window so
// screens read as a focused document rather than a full-width website.
// No-op on native, where screens already span the phone width.
export const webContent = Platform.select({
  web: { width: "100%" as const, maxWidth: 760, alignSelf: "center" as const },
  default: {},
});

export const statusColors: Record<string, { bg: string; fg: string; label: string }> = {
  DRAFT: { bg: colors.surfaceTertiary, fg: colors.onSurfaceTertiary, label: "Draft" },
  SENT: { bg: "#FEF3C7", fg: "#92400E", label: "Sent" },
  VIEWED: { bg: "#DBEAFE", fg: "#1E3A8A", label: "Viewed" },
  PARTIALLY_PAID: { bg: "#E6F3EB", fg: colors.brand, label: "Part-paid" },
  PAID: { bg: colors.brandTertiary, fg: colors.brand, label: "Paid" },
  OVERDUE: { bg: "#FEE2E2", fg: colors.error, label: "Overdue" },
  VOID: { bg: colors.surfaceTertiary, fg: colors.muted, label: "Void" },
  ACCEPTED: { bg: colors.brandTertiary, fg: colors.brand, label: "Accepted" },
  DECLINED: { bg: "#FEE2E2", fg: colors.error, label: "Declined" },
  CONVERTED: { bg: colors.surfaceTertiary, fg: colors.onSurfaceTertiary, label: "Converted" },
};
