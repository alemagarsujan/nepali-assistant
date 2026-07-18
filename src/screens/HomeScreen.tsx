import React, { useState } from "react";
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { strings } from "../i18n/ne";
import { callService } from "../services/callService";
import { llmService } from "../services/llmService";
import { reminderService } from "../services/reminderService";
import { secureStorage } from "../services/secureStorage";
import { voiceService } from "../services/voiceService";
import { Reminder } from "../types";

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
    console.log("DEBUG: handlePressOut fired");
    setState("processing");
    try {
      console.log("DEBUG: calling stopAndTranscribe");
      const transcript = await voiceService.stopAndTranscribe();
      console.log("DEBUG: got transcript:", transcript);
      const contacts = await secureStorage.getContacts();
      console.log("DEBUG: calling llmService.interpret");
      const intent = await llmService.interpret(
        transcript,
        contacts.map((c) => c.name)
      );
      console.log("DEBUG: got intent:", JSON.stringify(intent));

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
      console.warn("DEBUG: Assistant error message:", err instanceof Error ? err.message : String(err));
      console.warn("DEBUG: Assistant error full:", err);
      setState("speaking");
      try {
        await voiceService.speak(strings.errors.genericRetry);
      } catch (speakErr) {
        console.warn("DEBUG: even the error-speech failed:", speakErr);
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