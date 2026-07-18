import React, { useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, Alert } from "react-native";
import { strings } from "../i18n/ne";
import { voiceService } from "../services/voiceService";
import { llmService } from "../services/llmService";
import { reminderService } from "../services/reminderService";
import { callService } from "../services/callService";
import { secureStorage } from "../services/secureStorage";
import { Reminder } from "../types";

// Design principles for this screen, deliberately:
// - ONE primary action (the mic button). Everything else is secondary.
// - Text is large (28pt+) because the target user may have low vision.
// - Every state change is also spoken aloud, not just shown as text,
//   because reading may not be reliable for this audience.
// - No auto-timeouts that silently fail — every error is spoken + retryable.

type State = "idle" | "listening" | "processing" | "speaking";

export default function HomeScreen() {
  const [state, setState] = useState<State>("idle");

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
    try {
      const transcript = await voiceService.stopAndTranscribe();
      const contacts = await secureStorage.getContacts();
      const intent = await llmService.interpret(
        transcript,
        contacts.map((c) => c.name)
      );

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
          await voiceService.speak(
            strings.reminders.confirmSpoken(
              intent.medicineName,
              `${intent.hour}:${String(intent.minute).padStart(2, "0")}`
            )
          );
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
          await voiceService.speak(strings.contacts.confirmCall(match.name));
          await callService.placeCall(match);
          break;
        }
        case "ask_question": {
          setState("speaking");
          await voiceService.speak(intent.answer);
          break;
        }
        case "unclear": {
          setState("speaking");
          await voiceService.speak(strings.errors.genericRetry);
          break;
        }
      }
    } catch (err) {
      console.warn("Assistant error:", err);
      setState("speaking");
      await voiceService.speak(strings.errors.genericRetry);
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
});
