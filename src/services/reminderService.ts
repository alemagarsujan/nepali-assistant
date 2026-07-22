import * as Notifications from "expo-notifications";
import { strings } from "../i18n/ne";
import { Reminder } from "../types";
import { secureStorage } from "./secureStorage";

// Local daily-repeating notifications. No backend/network involved — the
// medicine alert has to keep working even if the phone has no signal, so
// everything here runs entirely on-device through expo-notifications.

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

async function ensurePermission(): Promise<boolean> {
  const existing = await Notifications.getPermissionsAsync();
  if (existing.status === "granted") return true;
  const requested = await Notifications.requestPermissionsAsync();
  return requested.status === "granted";
}

export const reminderService = {
  getAll: (): Promise<Reminder[]> => secureStorage.getReminders(),

  async scheduleReminder(reminder: Reminder): Promise<void> {
    const granted = await ensurePermission();

    let notificationId: string | undefined;
    if (granted) {
      notificationId = await Notifications.scheduleNotificationAsync({
        content: {
          title: strings.reminders.title,
          body: strings.reminders.alertSpoken(reminder.medicineName),
          sound: true,
        },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.CALENDAR,
          hour: reminder.hour,
          minute: reminder.minute,
          repeats: true,
        },
      });
    }
    // If permission was denied, we still save the reminder so it shows up
    // in the list — better a silent reminder the user can see and re-enable
    // notifications for, than one that silently vanishes.

    const current = await secureStorage.getReminders();
    await secureStorage.setReminders([...current, { ...reminder, notificationId }]);
  },

  async cancelReminder(id: string): Promise<void> {
    const current = await secureStorage.getReminders();
    const target = current.find((r) => r.id === id);
    if (target?.notificationId) {
      await Notifications.cancelScheduledNotificationAsync(target.notificationId);
    }
    await secureStorage.setReminders(current.filter((r) => r.id !== id));
  },
};