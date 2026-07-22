export interface Reminder {
  id: string;
  medicineName: string;
  hour: number; // 0-23
  minute: number; // 0-59
  daysOfWeek: number[]; // 0 = Sunday ... 6 = Saturday, empty = every day
  createdAt: string;
  notificationId?: string; // id returned by expo-notifications, used to cancel
}

export interface Contact {
  id: string;
  name: string;
  phoneNumber: string;
  // relationship helps disambiguate voice matches, e.g. "छोरा", "छोरी", "डाक्टर"
  relationship?: string;
}

// What the backend returns after transcribing + interpreting a spoken request
export type AssistantIntent =
  | { type: "set_reminder"; medicineName: string; hour: number; minute: number }
  | { type: "call_contact"; contactName: string }
  | { type: "ask_question"; question: string; answer: string }
  | { type: "unclear"; transcript: string };

export interface CaregiverPairing {
  code: string;
  expiresAt: string;
  paired: boolean;
}