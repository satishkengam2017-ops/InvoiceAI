import { useEffect } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import * as WebBrowser from "expo-web-browser";

import { colors } from "@/src/lib/theme";

// Native only: useSSO() (GoogleSignInButton.tsx) defaults its OAuth
// redirectUrl to this exact path (AuthSession.makeRedirectUri({ path:
// "sso-callback" })). This route's only job is to signal that the auth
// session is done so the window/popup that started openAuthSessionAsync can
// resolve and close — without it, the OAuth flow lands here and just
// dead-ends. Web uses a completely different, full-page-redirect flow with
// its own callback logic — see sso-callback.web.tsx.
export default function SSOCallback() {
  useEffect(() => {
    WebBrowser.maybeCompleteAuthSession();
  }, []);

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
