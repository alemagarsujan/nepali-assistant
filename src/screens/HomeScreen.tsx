import { useNavigation } from "@react-navigation/native";
import React, { useState } from "react";
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { strings } from "../i18n/ne";
import { assistantService } from "@/services/assistantService";
import { callService } from "@/services/callService";
import { reminderService } from "@/services/reminderService";
import { secureStorage } from "@/services/secureStorage";
import { voiceService } from "@/services/voiceService";
import { Reminder } from "@/types";

type State = "idle" | "listening" | "processing" | "speaking";

export default function HomeScreen() {
  const [state, setState] = useState<State>("idle");
  const navigation = useNavigation<any>();

  async function handlePressIn() {
    const granted = await voiceService.requestPermission();
    if (!granted) {
      await voiceService.speak(strings.errors.noMicPermission);
      return;
    }
    setState("listening");
    await voiceService.startRecording();
  }

  async function handlePressOut() {
    setState("processing");
    const t0 = Date.now();
    const elapsed = () => `${Date.now() - t0}ms`;
    try {
      const uri = await voiceService.stopRecordingToFile();
      console.log(`⏱ [client] recording finalized after ${elapsed()}`);
      const contacts = await secureStorage.getContacts();
      const { intent, audioBase64 } = await assistantService.send(
        uri,
        contacts.map((c) => c.name)
      );
      console.log(`⏱ [client] got intent+audio after ${elapsed()} total (mic release to now)`);

      switch (intent.type) {
        case "set_reminder": {
          const reminder: Reminder = {
            id: `${Date.now()}`,
            medicineName: intent.medicineName,
            hour: intent.hour,
            minute: intent.minute,
            daysOfWeek: [],
            createdAt: new Date().toISOString(),
          };
          await reminderService.scheduleReminder(reminder);
          setState("speaking");
          await voiceService.playAudioBase64(audioBase64);
          console.log(`⏱ [client] reply audio started playing after ${elapsed()} total`);
          break;
        }
        case "call_contact": {
          const match = callService.findBestMatch(intent.contactName, contacts);
          if (!match) {
            setState("speaking");
            await voiceService.speak(strings.contacts.noMatch);
            break;
          }
          setState("speaking");
          await voiceService.playAudioBase64(audioBase64);
          console.log(`⏱ [client] reply audio started playing after ${elapsed()} total`);
          await callService.placeCall(match);
          break;
        }
        case "ask_question": {
          setState("speaking");
          await voiceService.playAudioBase64(audioBase64);
          console.log(`⏱ [client] reply audio started playing after ${elapsed()} total`);
          break;
        }
        case "unclear": {
          setState("speaking");
          await voiceService.speak(strings.errors.genericRetry);
          break;
        }
      }
    } catch (err) {
      console.warn("Assistant error:", err instanceof Error ? err.message : String(err));
      setState("speaking");
      try {
        await voiceService.speak(strings.errors.genericRetry);
      } catch (speakErr) {
        console.warn("even the error-speech failed:", speakErr);
      }
    } finally {
      setState("idle");
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.greeting}>{strings.home.greeting}</Text>

      <TouchableOpacity
        style={[styles.micButton, state !== "idle" && styles.micButtonActive]}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        activeOpacity={0.8}
      >
        {state === "processing" ? (
          <ActivityIndicator size="large" color="#fff" />
        ) : (
          <Text style={styles.micIcon}>🎤</Text>
        )}
      </TouchableOpacity>

      <Text style={styles.statusText}>
        {state === "listening" && strings.home.listeningPrompt}
        {state === "processing" && strings.home.processing}
        {state === "idle" && strings.home.micButtonLabel}
      </Text>

      <View style={styles.navRow}>
        <TouchableOpacity style={styles.navButton} onPress={() => navigation.navigate("Contacts")}>
          <Text style={styles.navButtonText}>📞 {strings.contacts.title}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.navButton} onPress={() => navigation.navigate("Reminders")}>
          <Text style={styles.navButtonText}>💊 {strings.reminders.title}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.navButton} onPress={() => navigation.navigate("Settings")}>
          <Text style={styles.navButtonText}>⚙️ {strings.settings.title}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  greeting: { fontSize: 30, fontWeight: "700", textAlign: "center", marginBottom: 48 },
  micButton: {
    width: 180,
    height: 180,
    borderRadius: 90,
    backgroundColor: "#2E7D32",
    alignItems: "center",
    justifyContent: "center",
    elevation: 4,
  },
  micButtonActive: { backgroundColor: "#C62828" },
  micIcon: { fontSize: 72 },
  statusText: { fontSize: 22, marginTop: 32, color: "#444", textAlign: "center" },
  navRow: { flexDirection: "row", marginTop: 48, gap: 12 },
  navButton: {
    backgroundColor: "#f0f0f0",
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 12,
  },
  navButtonText: { fontSize: 16, fontWeight: "600", color: "#333" },
});