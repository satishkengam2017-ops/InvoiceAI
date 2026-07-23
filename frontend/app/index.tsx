import { ActivityIndicator, StyleSheet, View } from "react-native";

import { colors } from "@/src/lib/theme";

export default function Index() {
  // AuthProvider handles route redirects. Render a spinner while it bootstraps.
  return (
    <View style={styles.wrap}>
      <ActivityIndicator size="large" color={colors.brand} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
  },
});
