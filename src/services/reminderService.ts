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

    const notificationIds: string[] = [];
    if (granted) {
      const content = {
        title: strings.reminders.title,
        body: strings.reminders.alertSpoken(reminder.medicineName),
        sound: true,
      };

      if (reminder.daysOfWeek.length === 0) {
        // No specific days picked — fire every day.
        notificationIds.push(
          await Notifications.scheduleNotificationAsync({
            content,
            trigger: {
              type: Notifications.SchedulableTriggerInputTypes.CALENDAR,
              hour: reminder.hour,
              minute: reminder.minute,
              repeats: true,
            },
          })
        );
      } else {
        // One weekly-repeating trigger per selected day. Reminder.daysOfWeek
        // uses JS Date convention (0 = Sunday), expo-notifications' WEEKLY
        // trigger uses 1 = Sunday, so shift by one.
        for (const day of reminder.daysOfWeek) {
          notificationIds.push(
            await Notifications.scheduleNotificationAsync({
              content,
              trigger: {
                type: Notifications.SchedulableTriggerInputTypes.WEEKLY,
                weekday: day + 1,
                hour: reminder.hour,
                minute: reminder.minute,
              },
            })
          );
        }
      }
    }
    // If permission was denied, we still save the reminder so it shows up
    // in the list — better a silent reminder the user can see and re-enable
    // notifications for, than one that silently vanishes.

    const current = await secureStorage.getReminders();
    await secureStorage.setReminders([...current, { ...reminder, notificationIds }]);
  },

  async cancelReminder(id: string): Promise<void> {
    const current = await secureStorage.getReminders();
    const target = current.find((r) => r.id === id);
    if (target?.notificationIds?.length) {
      await Promise.all(
        target.notificationIds.map((notifId) =>
          Notifications.cancelScheduledNotificationAsync(notifId)
        )
      );
    }
    await secureStorage.setReminders(current.filter((r) => r.id !== id));
  },
};