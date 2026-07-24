import * as SecureStore from "expo-secure-store";

// Wrapper around expo-secure-store so the rest of the app never touches the
// raw API and always goes through JSON-safe helpers. SecureStore uses the iOS
// Keychain and Android Keystore under the hood — hardware-backed encryption,
// not plain-text AsyncStorage. This is where reminders and contacts live.
//
// IMPORTANT: SecureStore has a ~2KB per-key limit on some Android configs, so
// we store collections as a single JSON blob per key (e.g. all reminders under
// one "reminders" key) rather than one key per item, and keep payload sizes
// modest. If the reminder/contact list ever grows large, migrate to
// expo-sqlite with SQLCipher for encrypted-at-rest local DB instead.

const REMINDERS_KEY = "reminders_v1";
const CONTACTS_KEY = "contacts_v1";
const CAREGIVER_KEY = "caregiver_pairing_v1";
const NOTIFICATION_READING_ENABLED_KEY = "notification_reading_enabled_v1";

async function getJSON<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await SecureStore.getItemAsync(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch (err) {
    console.warn(`secureStorage: failed to read ${key}`, err);
    return fallback;
  }
}

async function setJSON(key: string, value: unknown): Promise<void> {
  await SecureStore.setItemAsync(key, JSON.stringify(value));
}

export const secureStorage = {
  getReminders: () => getJSON(REMINDERS_KEY, [] as import("../types").Reminder[]),
  setReminders: (reminders: import("../types").Reminder[]) =>
    setJSON(REMINDERS_KEY, reminders),

  getContacts: () => getJSON(CONTACTS_KEY, [] as import("../types").Contact[]),
  setContacts: (contacts: import("../types").Contact[]) =>
    setJSON(CONTACTS_KEY, contacts),

  getCaregiverPairing: () =>
    getJSON<import("../types").CaregiverPairing | null>(CAREGIVER_KEY, null),
  setCaregiverPairing: (pairing: import("../types").CaregiverPairing | null) =>
    setJSON(CAREGIVER_KEY, pairing),

  getNotificationReadingEnabled: () => getJSON(NOTIFICATION_READING_ENABLED_KEY, false),
  setNotificationReadingEnabled: (enabled: boolean) =>
    setJSON(NOTIFICATION_READING_ENABLED_KEY, enabled),

  // Full wipe — expose this in Settings as "Erase my data" for user trust.
  wipeAll: async () => {
    await SecureStore.deleteItemAsync(REMINDERS_KEY);
    await SecureStore.deleteItemAsync(CONTACTS_KEY);
    await SecureStore.deleteItemAsync(CAREGIVER_KEY);
    await SecureStore.deleteItemAsync(NOTIFICATION_READING_ENABLED_KEY);
  },
};
