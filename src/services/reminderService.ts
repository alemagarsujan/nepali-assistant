import * as Notifications from "expo-notifications";
import { Reminder } from "../types";
import { strings } from "../i18n/ne";
import { secureStorage } from "./secureStorage";

// Medicine reminders MUST work without internet — this is the single feature
// that cannot be allowed to fail silently. expo-notifications schedules
// entirely on-device, so a reminder set once keeps firing even if the phone
// never sees a network connection again.

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export const reminderService = {
  async requestPermission(): Promise<boolean> {
    const { status } = await Notifications.requestPermissionsAsync();
    return status === "granted";
  },

  async scheduleReminder(reminder: Reminder): Promise<void> {
    const trigger: Notifications.NotificationTriggerInput = reminder.daysOfWeek.length
      ? { hour: reminder.hour, minute: reminder.minute, repeats: true, weekday: undefined }
      : { hour: reminder.hour, minute: reminder.minute, repeats: true };

    await Notifications.scheduleNotificationAsync({
      identifier: reminder.id,
      content: {
        title: strings.reminders.title,
        body: strings.reminders.alertSpoken(reminder.medicineName),
        sound: true,
        // Volume/loudness for hearing-impaired users is a device-level
        // setting we can't override, but we can make sure the sound file
        // used here is a distinct, easily-recognized chime — configure a
        // custom sound asset for production.
      },
      trigger,
    });

    const existing = await secureStorage.getReminders();
    await secureStorage.setReminders([...existing, reminder]);
  },

  async cancelReminder(id: string): Promise<void> {
    await Notifications.cancelScheduledNotificationAsync(id);
    const existing = await secureStorage.getReminders();
    await secureStorage.setReminders(existing.filter((r) => r.id !== id));
  },

  async getAll(): Promise<Reminder[]> {
    return secureStorage.getReminders();
  },
};
