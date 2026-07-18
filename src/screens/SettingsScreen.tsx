import React, { useState } from "react";
import { Alert, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { strings } from "../i18n/ne";
import { secureStorage } from "../services/secureStorage";

const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL ?? "https://nepali-assistant.onrender.com";

// Caregiver pairing: generates a short-lived code on the backend, shown once
// on screen. The caregiver enters it in their own (separate) companion app
// to link accounts. Code expires in 10 minutes and is single-use — this
// avoids a shared login/password model, which is both less secure and
// harder for an elderly user to manage.

export default function SettingsScreen() {
  const [pairingCode, setPairingCode] = useState<string | null>(null);

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
        onPress: () => secureStorage.wipeAll(),
      },
    ]);
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
