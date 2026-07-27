import { Alert, Platform } from "react-native";

// Alert.alert with multiple buttons is a no-op on react-native-web (it only
// logs), so a destructive confirm needs a platform split: the browser's
// native confirm() on web, Alert.alert's button callbacks on native.
export function confirmAsync(title: string, message: string): Promise<boolean> {
  if (Platform.OS === "web") {
    return Promise.resolve(typeof window !== "undefined" ? window.confirm(`${title}\n\n${message}`) : false);
  }
  return new Promise((resolve) => {
    Alert.alert(title, message, [
      { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
      { text: "Delete", style: "destructive", onPress: () => resolve(true) },
    ]);
  });
}
