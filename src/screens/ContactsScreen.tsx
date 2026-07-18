import React, { useEffect, useState } from "react";
import { View, Text, FlatList, TouchableOpacity, StyleSheet } from "react-native";
import * as ExpoContacts from "expo-contacts";
import { strings } from "../i18n/ne";
import { secureStorage } from "../services/secureStorage";
import { callService } from "../services/callService";
import { Contact } from "../types";

// Deliberately NOT syncing the phone's full contact list automatically — the
// user (or caregiver) picks a short curated list of important people
// (family, doctor, neighbor). A long unfiltered contact list is harder for
// voice-matching and harder for an elderly user to scan visually.

export default function ContactsScreen() {
  const [contacts, setContacts] = useState<Contact[]>([]);

  useEffect(() => {
    secureStorage.getContacts().then(setContacts);
  }, []);

  async function handleImport() {
    const { status } = await ExpoContacts.requestPermissionsAsync();
    if (status !== "granted") return;
    const { data } = await ExpoContacts.getContactsAsync({
      fields: [ExpoContacts.Fields.PhoneNumbers],
    });
    // In the real app this opens a picker UI; simplified here to first 5
    // contacts with a phone number, for scaffold purposes.
    const picked: Contact[] = data
      .filter((c) => c.phoneNumbers?.length)
      .slice(0, 5)
      .map((c) => ({
        id: c.id ?? `${Date.now()}-${Math.random()}`,
        name: c.name ?? "Unknown",
        phoneNumber: c.phoneNumbers![0].number ?? "",
      }));
    await secureStorage.setContacts(picked);
    setContacts(picked);
  }

  async function handleCall(contact: Contact) {
    await callService.placeCall(contact);
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>{strings.contacts.title}</Text>
      <TouchableOpacity style={styles.importBtn} onPress={handleImport}>
        <Text style={styles.importBtnText}>+ थप्नुहोस्</Text>
      </TouchableOpacity>
      <FlatList
        data={contacts}
        keyExtractor={(c) => c.id}
        renderItem={({ item }) => (
          <TouchableOpacity style={styles.row} onPress={() => handleCall(item)}>
            <Text style={styles.name}>{item.name}</Text>
            <Text style={styles.callIcon}>📞</Text>
          </TouchableOpacity>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20 },
  title: { fontSize: 26, fontWeight: "700", marginBottom: 12 },
  importBtn: {
    backgroundColor: "#2E7D32",
    padding: 14,
    borderRadius: 10,
    alignItems: "center",
    marginBottom: 16,
  },
  importBtnText: { color: "#fff", fontSize: 18, fontWeight: "600" },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 18,
    borderBottomWidth: 1,
    borderBottomColor: "#eee",
  },
  name: { fontSize: 22, fontWeight: "600" },
  callIcon: { fontSize: 26 },
});
