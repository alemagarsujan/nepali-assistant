import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import React, { useEffect } from "react";
import ContactsScreen from "./src/screens/ContactsScreen";
import HomeScreen from "./src/screens/HomeScreen";
import RemindersScreen from "./src/screens/RemindersScreen";
import SettingsScreen from "./src/screens/SettingsScreen";
import {
  hasNotificationListenerPermission,
  isNotificationListenerAvailable,
  startNotificationListener,
} from "./src/services/notificationService";
import { secureStorage } from "./src/services/secureStorage";

const Stack = createNativeStackNavigator();

// Large default header titles and back buttons — react-navigation's native
// stack gives us the OS-native large-title feel on iOS and a familiar back
// arrow on Android for free, which matters for an audience that relies on
// platform conventions they already half-know from other apps.

export default function App() {
  // Resume reading notifications on launch if the user turned it on last
  // time and permission is still granted — this only covers "app process is
  // running" (foreground, backgrounded, or Android-recycled-but-alive); a
  // fully force-stopped app needs a foreground service to be woken back up,
  // which isn't in place yet (see notificationService.ts).
  useEffect(() => {
    if (!isNotificationListenerAvailable) return;
    (async () => {
      const enabled = await secureStorage.getNotificationReadingEnabled();
      if (enabled && hasNotificationListenerPermission()) {
        startNotificationListener();
      }
    })();
  }, []);

  return (
    <NavigationContainer>
      <Stack.Navigator
        screenOptions={{
          headerTitleStyle: { fontSize: 22 },
        }}
      >
        <Stack.Screen name="Home" component={HomeScreen} options={{ title: "सहयोगी" }} />
        <Stack.Screen
          name="Reminders"
          component={RemindersScreen}
          options={{ title: "औषधिको समय" }}
        />
        <Stack.Screen
          name="Contacts"
          component={ContactsScreen}
          options={{ title: "फोन गर्नुहोस्" }}
        />
        <Stack.Screen name="Settings" component={SettingsScreen} options={{ title: "सेटिङ" }} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
