import { Redirect } from "expo-router";
import { ActivityIndicator, StyleSheet, View } from "react-native";

import { useAuth } from "@/src/context/AuthContext";
import { colors } from "@/src/lib/theme";

export default function Index() {
  const { user, business, bootstrapping } = useAuth();

  // The AuthContext route guard covers (auth)/onboarding transitions, but a
  // cold load on "/" for a signed-in, onboarded user matches none of its
  // branches — redirect explicitly once the session is known.
  if (!bootstrapping) {
    if (!user) return <Redirect href="/(auth)/sign-in" />;
    if (business && !business.onboarded) return <Redirect href="/onboarding" />;
    return <Redirect href="/(app)/dashboard" />;
  }

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
