import * as Linking from "expo-linking";
import { Contact } from "../types";

// Uses the phone's native dialer via a tel: link — the call itself never
// touches your backend or any third party. This is the most private and
// most reliable way to place a call; no VoIP service, no extra permission
// beyond CALL_PHONE on Android for one-tap dialing.

export const callService = {
  findBestMatch(spokenName: string, contacts: Contact[]): Contact | null {
    const normalized = spokenName.trim().toLowerCase();
    // Exact match first, then "contains" as a forgiving fallback for
    // mispronunciation or partial names ("Ram" matching "Ram Bahadur").
    return (
      contacts.find((c) => c.name.toLowerCase() === normalized) ??
      contacts.find((c) => c.name.toLowerCase().includes(normalized)) ??
      null
    );
  },

  async placeCall(contact: Contact): Promise<void> {
    const url = `tel:${contact.phoneNumber}`;
    const canOpen = await Linking.canOpenURL(url);
    if (!canOpen) throw new Error("Device cannot place calls");
    await Linking.openURL(url);
  },
};
