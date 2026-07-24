import { Audio } from "expo-av";
import Constants, { ExecutionEnvironment } from "expo-constants";
import * as FileSystem from "expo-file-system/legacy";
import { Platform } from "react-native";

// Reads phone notifications aloud in Nepali, translating from English (or
// any language) when needed. Android-only: iOS has no API that lets one app
// see another app's notifications, full stop — there's no fallback path
// here the way there is for mic streaming (see voiceService.ts's Expo Go
// fallback). On iOS/Expo Go this whole module is inert; every exported
// function is a safe no-op.
//
// Same lazy-require reasoning as voiceService's @speechmatics module: a
// top-level import of a custom native module gets evaluated by Metro
// regardless of which platform actually runs it, and Expo Go can't load an
// unlisted native module — so it's only ever require()'d after confirming
// we're in a dev-client/standalone build.
export const isNotificationListenerAvailable =
  Platform.OS === "android" && Constants.executionEnvironment !== ExecutionEnvironment.StoreClient;

const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL ?? "https://nepali-assistant.onrender.com";

// Our own app's package — never read our own notifications back to us.
const OWN_PACKAGE_NAME = "com.sahayogi.assistant";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let listenerModule: any = undefined;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getListenerModule(): any {
  if (!isNotificationListenerAvailable) return null;
  if (listenerModule !== undefined) return listenerModule;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    listenerModule = require("expo-android-notification-listener-service").default;
  } catch (err) {
    console.warn("notification listener module unavailable:", err);
    listenerModule = null;
  }
  return listenerModule;
}

export interface NotificationData {
  packageName: string;
  id: number;
  title: string;
  text: string;
  bigText: string;
  subText: string;
  summaryText: string;
  postTime: number;
  key: string;
  appName: string;
  appIconPath: string;
}

// Android's special-access permission for reading other apps' notifications
// can't be requested through a normal runtime permission dialog — it's
// granted (or not) from a dedicated system settings screen the user has to
// visit manually.
export function hasNotificationListenerPermission(): boolean {
  const mod = getListenerModule();
  if (!mod) return false;
  try {
    return !!mod.isNotificationPermissionGranted();
  } catch {
    return false;
  }
}

export function openNotificationListenerSettings(): void {
  const mod = getListenerModule();
  mod?.openNotificationListenerSettings();
}

// Speaks notifications strictly one at a time, in arrival order — if two
// notifications land close together and both start playback immediately,
// they talk over each other (same double-voice bug fixed earlier for
// assistant replies). Each item is its own fetch to /api/notify-speak
// (translate/compose) + play, queued so item N+1 only starts once N has
// actually finished playing.
let speakQueue: Promise<void> = Promise.resolve();
function enqueueSpeak(job: () => Promise<void>): void {
  speakQueue = speakQueue.then(job).catch((err) => console.warn("notification speak failed:", err));
}

async function speakNotification(n: NotificationData): Promise<void> {
  const res = await fetch(`${BACKEND_URL}/api/notify-speak`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      appName: n.appName || n.packageName,
      title: n.title,
      text: n.bigText || n.text,
    }),
  });
  if (!res.ok) throw new Error(`notify-speak failed: ${res.status}`);

  const arrayBuffer = await res.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(arrayBuffer);
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  const base64Audio = btoa(binary);

  const fileUri = `${FileSystem.cacheDirectory}notif-${Date.now()}.wav`;
  await FileSystem.writeAsStringAsync(fileUri, base64Audio, { encoding: "base64" });
  const { sound } = await Audio.Sound.createAsync({ uri: fileUri }, { shouldPlay: true });

  await new Promise<void>((resolve) => {
    sound.setOnPlaybackStatusUpdate((status) => {
      if (status.isLoaded && status.didJustFinish) {
        sound.unloadAsync().catch(() => {});
        resolve();
      }
    });
  });
}

// The library itself only dedupes the exact same notification key within a
// 500ms window (meant for catching duplicate system callbacks, not repeat
// notifications) — a progress bar or media-player notification that updates
// every few seconds would otherwise get read aloud every single time it
// changes. Recently-spoken (packageName+title+text) combos are suppressed
// for a short window on top of that; a genuinely new message from the same
// app still gets through immediately since its text differs.
const RECENT_WINDOW_MS = 30_000;
const recentlySpoken = new Map<string, number>();
function isDuplicate(n: NotificationData): boolean {
  const key = `${n.packageName}|${n.title}|${n.text}`;
  const now = Date.now();
  for (const [k, t] of recentlySpoken) {
    if (now - t > RECENT_WINDOW_MS) recentlySpoken.delete(k);
  }
  const last = recentlySpoken.get(key);
  recentlySpoken.set(key, now);
  return last !== undefined && now - last <= RECENT_WINDOW_MS;
}

// Module-level singleton so App.tsx (start on launch, if previously enabled)
// and SettingsScreen (start/stop on toggle) can both call these freely
// without either one needing to track whether the other already has a
// listener running.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let activeSubscription: any = null;

// Starts listening for every notification from every app (subject to the
// filtering above) and speaks each one aloud, translated to Nepali if
// needed. Only call this when isNotificationListenerAvailable is true and
// hasNotificationListenerPermission() is true. Safe to call repeatedly —
// a second call while already running is a no-op.
export function startNotificationListener(): void {
  if (activeSubscription) return;
  const mod = getListenerModule();
  if (!mod) return;

  // Empty array = allow every package (confirmed via the module's Kotlin
  // source: allowedPackages.isEmpty() || allowedPackages.contains(...)) —
  // matches the user's explicit choice of "every app", not just messaging
  // apps.
  mod.setAllowedPackages([]);

  activeSubscription = mod.addListener("onNotificationReceived", (n: NotificationData) => {
    if (!n || n.packageName === OWN_PACKAGE_NAME) return;
    if (!n.title && !n.text && !n.bigText) return;
    if (isDuplicate(n)) return;
    enqueueSpeak(() => speakNotification(n));
  });
}

export function stopNotificationListener(): void {
  activeSubscription?.remove();
  activeSubscription = null;
}

export function isNotificationListenerRunning(): boolean {
  return activeSubscription !== null;
}
