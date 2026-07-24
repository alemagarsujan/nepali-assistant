import React, { useCallback, useEffect, useState } from "react";
import { Alert, AppState, StyleSheet, Switch, Text, TouchableOpacity, View } from "react-native";
import { strings } from "../i18n/ne";
import {
  hasNotificationListenerPermission,
  isNotificationListenerAvailable,
  openNotificationListenerSettings,
  startNotificationListener,
  stopNotificationListener,
} from "../services/notificationService";
import { secureStorage } from "../services/secureStorage";

const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL ?? "https://nepali-assistant.onrender.com";

// Caregiver pairing: generates a short-lived code on the backend, shown once
// on screen. The caregiver enters it in their own (separate) companion app
// to link accounts. Code expires in 10 minutes and is single-use — this
// avoids a shared login/password model, which is both less secure and
// harder for an elderly user to manage.

export default function SettingsScreen() {
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [notifEnabled, setNotifEnabled] = useState(false);
  const [hasPermission, setHasPermission] = useState(false);

  const refreshPermission = useCallback(() => {
    if (isNotificationListenerAvailable) {
      setHasPermission(hasNotificationListenerPermission());
    }
  }, []);

  useEffect(() => {
    secureStorage.getNotificationReadingEnabled().then(setNotifEnabled);
    refreshPermission();

    // The notification-listener permission is granted from a system
    // settings screen outside the app (see openNotificationListenerSettings
    // below) — there's no callback for that, so re-check whenever the app
    // comes back to the foreground instead.
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") refreshPermission();
    });
    return () => sub.remove();
  }, [refreshPermission]);

  async function handlePairCaregiver() {
    try {
      const res = await fetch(`${BACKEND_URL}/api/pairing/create`, { method: "POST" });
      const { code, expiresAt } = await res.json();
      setPairingCode(code);
      await secureStorage.setCaregiverPairing({ code, expiresAt, paired: false });
    } catch {
      Alert.alert(strings.errors.noInternet);
    }
  }

  async function handleWipeData() {
    Alert.alert("तपाईंको सबै डाटा मेटिनेछ", "", [
      { text: "रद्द गर्नुहोस्", style: "cancel" },
      {
        text: "मेटाउनुहोस्",
        style: "destructive",
        onPress: () => {
          stopNotificationListener();
          setNotifEnabled(false);
          secureStorage.wipeAll();
        },
      },
    ]);
  }

  async function handleToggleNotifications(value: boolean) {
    if (value && !hasPermission) {
      // Can't turn it on without the permission — send them to grant it
      // instead of silently flipping the switch back off.
      openNotificationListenerSettings();
      return;
    }
    setNotifEnabled(value);
    await secureStorage.setNotificationReadingEnabled(value);
    if (value) startNotificationListener();
    else stopNotificationListener();
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>{strings.settings.title}</Text>

      <TouchableOpacity style={styles.button} onPress={handlePairCaregiver}>
        <Text style={styles.buttonText}>{strings.settings.pairCaregiver}</Text>
      </TouchableOpacity>

      {pairingCode && (
        <View style={styles.codeBox}>
          <Text style={styles.codeLabel}>{strings.settings.pairingCode}</Text>
          <Text style={styles.code}>{pairingCode}</Text>
        </View>
      )}

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>{strings.settings.notifications.title}</Text>
        <Text style={styles.sectionDescription}>{strings.settings.notifications.description}</Text>

        {!isNotificationListenerAvailable ? (
          <Text style={styles.hint}>{strings.settings.notifications.androidOnly}</Text>
        ) : (
          <>
            <View style={styles.switchRow}>
              <Text style={styles.switchLabel}>
                {notifEnabled ? strings.settings.notifications.toggleOn : strings.settings.notifications.toggleOff}
              </Text>
              <Switch value={notifEnabled && hasPermission} onValueChange={handleToggleNotifications} />
            </View>

            {!hasPermission && (
              <>
                <Text style={styles.hint}>{strings.settings.notifications.needsPermission}</Text>
                <TouchableOpacity style={styles.button} onPress={openNotificationListenerSettings}>
                  <Text style={styles.buttonText}>{strings.settings.notifications.permissionButton}</Text>
                </TouchableOpacity>
                <Text style={styles.hint}>{strings.settings.notifications.permissionHint}</Text>
              </>
            )}
          </>
        )}
      </View>

      <TouchableOpacity style={styles.dangerButton} onPress={handleWipeData}>
        <Text style={styles.dangerButtonText}>मेरो सबै डाटा मेटाउनुहोस्</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20 },
  title: { fontSize: 26, fontWeight: "700", marginBottom: 24 },
  button: {
    backgroundColor: "#2E7D32",
    padding: 16,
    borderRadius: 10,
    alignItems: "center",
    marginBottom: 16,
  },
  buttonText: { color: "#fff", fontSize: 18, fontWeight: "600" },
  codeBox: { alignItems: "center", marginVertical: 20 },
  codeLabel: { fontSize: 16, color: "#555" },
  code: { fontSize: 36, fontWeight: "800", letterSpacing: 4, marginTop: 8 },
  section: {
    marginTop: 24,
    marginBottom: 8,
    padding: 16,
    borderRadius: 10,
    backgroundColor: "#f5f5f5",
  },
  sectionTitle: { fontSize: 20, fontWeight: "700", marginBottom: 8 },
  sectionDescription: { fontSize: 15, color: "#555", marginBottom: 16 },
  switchRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  switchLabel: { fontSize: 17, fontWeight: "600", flex: 1, marginRight: 12 },
  hint: { fontSize: 14, color: "#888", marginTop: 8, marginBottom: 8 },
  dangerButton: {
    borderColor: "#C62828",
    borderWidth: 1,
    padding: 16,
    borderRadius: 10,
    alignItems: "center",
    marginTop: 40,
  },
  dangerButtonText: { color: "#C62828", fontSize: 16, fontWeight: "600" },
});
