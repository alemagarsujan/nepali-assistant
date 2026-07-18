import React from "react";
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import HomeScreen from "./src/screens/HomeScreen";
import RemindersScreen from "./src/screens/RemindersScreen";
import ContactsScreen from "./src/screens/ContactsScreen";
import SettingsScreen from "./src/screens/SettingsScreen";

const Stack = createNativeStackNavigator();

// Large default header titles and back buttons — react-navigation's native
// stack gives us the OS-native large-title feel on iOS and a familiar back
// arrow on Android for free, which matters for an audience that relies on
// platform conventions they already half-know from other apps.

export default function App() {
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
