import { reminderService } from "@/services/reminderService";
import React, { useEffect, useState } from "react";
import { FlatList, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { strings } from "../i18n/ne";
import { Reminder } from "../types";

// Kept deliberately simple: large rows, big delete button, no nested forms.
// Adding a NEW reminder by voice (via HomeScreen) is the primary path —
// this screen is mainly for reviewing/removing what's already set, which is
// easier to do by tapping than by voice.

export default function RemindersScreen() {
  const [reminders, setReminders] = useState<Reminder[]>([]);

  useEffect(() => {
    reminderService.getAll().then(setReminders);
  }, []);

  async function handleDelete(id: string) {
    await reminderService.cancelReminder(id);
    setReminders((prev) => prev.filter((r) => r.id !== id));
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>{strings.reminders.title}</Text>
      <FlatList
        data={reminders}
        keyExtractor={(r) => r.id}
        ListEmptyComponent={<Text style={styles.empty}>कुनै औषधि समय राखिएको छैन</Text>}
        renderItem={({ item }) => (
          <View style={styles.row}>
            <View>
              <Text style={styles.medicineName}>{item.medicineName}</Text>
              <Text style={styles.time}>
                {String(item.hour).padStart(2, "0")}:{String(item.minute).padStart(2, "0")}
              </Text>
            </View>
            <TouchableOpacity style={styles.deleteBtn} onPress={() => handleDelete(item.id)}>
              <Text style={styles.deleteBtnText}>✕</Text>
            </TouchableOpacity>
          </View>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20 },
  title: { fontSize: 26, fontWeight: "700", marginBottom: 20 },
  empty: { fontSize: 18, color: "#777", textAlign: "center", marginTop: 40 },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: "#eee",
  },
  medicineName: { fontSize: 22, fontWeight: "600" },
  time: { fontSize: 18, color: "#555", marginTop: 4 },
  deleteBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "#C62828",
    alignItems: "center",
    justifyContent: "center",
  },
  deleteBtnText: { color: "#fff", fontSize: 20, fontWeight: "700" },
});
