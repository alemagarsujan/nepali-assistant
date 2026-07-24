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
  if (!isNotificationListenerAvailable) {
    console.log(
      `🔔 notification listener unavailable: platform=${Platform.OS} executionEnvironment=${Constants.executionEnvironment}`
    );
    return null;
  }
  if (listenerModule !== undefined) return listenerModule;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    listenerModule = require("expo-android-notification-listener-service").default;
    console.log(`🔔 notification listener module loaded: ${listenerModule ? "ok" : "null"}`);
  } catch (err) {
    console.warn("🔔 notification listener module unavailable:", err);
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
  console.log(`🔔 speaking notification from ${n.appName || n.packageName}: "${n.title}"`);
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

// Skips anything that looks like a one-time code or a financial/banking
// notification — these can come from literally any app (Gmail forwarding an
// OTP email, the default Messages app for an SMS OTP, a bank/wallet app's
// own notification, etc.), so this is content-based rather than tied to
// specific package names. Matched text is never sent anywhere, including to
// our own backend — the check runs before speakNotification() is ever
// called, so a code or balance never leaves the device.
const OTP_PATTERNS = [
  /\botp\b/i,
  /one[\s-]?time\s?(password|code|pin)/i,
  /verification\s?code/i,
  /security\s?code/i,
  /auth(entication)?\s?code/i,
  /login\s?code/i,
  /access\s?code/i,
  /pass\s?code/i,
  /\b2fa\b/i,
  /\bpin\s?is\b/i,
  /do not share.*code/i,
  /गोप्य कोड/,
  /प्रमाणीकरण कोड/,
  /भेरिफिकेसन कोड/,
  /एकपटक.*कोड/,
];

const FINANCIAL_PATTERNS = [
  /\bdebited\b/i,
  /\bcredited\b/i,
  /\bdebit\b/i,
  /\bcredit\b/i,
  /transaction/i,
  /\bupi\b/i,
  /\bneft\b/i,
  /\bimps\b/i,
  /\brtgs\b/i,
  /a\/?c\s?(balance|no)/i,
  /available\s?bal/i,
  /account\s?balance/i,
  /wallet\s?balance/i,
  /withdrawn/i,
  /deposited/i,
  /paid\s?(to|via|from)/i,
  /payment\s?(received|sent|of)/i,
  /\bemi\b/i,
  /card\s?ending/i,
  /insufficient\s?funds/i,
  /esewa/i,
  /khalti/i,
  /imepay/i,
  /connectips/i,
  /बैंक/,
  /खाता/,
  /रकम/,
  /भुक्तानी/,
  /जम्मा/,
  /निकासी/,
];

function isSensitiveNotification(n: NotificationData): boolean {
  const combined = `${n.title} ${n.text} ${n.bigText} ${n.subText}`;
  return OTP_PATTERNS.some((p) => p.test(combined)) || FINANCIAL_PATTERNS.some((p) => p.test(combined));
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

// Starts listening for every notification from every app — except anything
// that looks like an OTP/verification code or a financial/banking
// notification (see isSensitiveNotification above), which are skipped
// entirely and never leave the device — and speaks the rest aloud,
// translated to Nepali if needed. Only call this when
// isNotificationListenerAvailable is true and hasNotificationListenerPermission()
// is true. Safe to call repeatedly — a second call while already running is
// a no-op.
export function startNotificationListener(): void {
  if (activeSubscription) {
    console.log("🔔 startNotificationListener: already running, skipping");
    return;
  }
  const mod = getListenerModule();
  if (!mod) {
    console.log("🔔 startNotificationListener: no module, aborting");
    return;
  }
  if (!mod.isNotificationPermissionGranted()) {
    console.log("🔔 startNotificationListener: permission not granted, aborting");
    return;
  }

  // Empty array = allow every package (confirmed via the module's Kotlin
  // source: allowedPackages.isEmpty() || allowedPackages.contains(...)) —
  // matches the user's explicit choice of "every app", not just messaging
  // apps.
  mod.setAllowedPackages([]);

  activeSubscription = mod.addListener("onNotificationReceived", (n: NotificationData) => {
    console.log(`🔔 notification received: package=${n?.packageName} title="${n?.title}" text="${n?.text}"`);
    if (!n || n.packageName === OWN_PACKAGE_NAME) {
      console.log("🔔 skipped: own package");
      return;
    }
    if (!n.title && !n.text && !n.bigText) {
      console.log("🔔 skipped: empty content");
      return;
    }
    if (isSensitiveNotification(n)) {
      console.log("🔔 skipped: looks like OTP/financial content");
      return;
    }
    if (isDuplicate(n)) {
      console.log("🔔 skipped: duplicate within 30s window");
      return;
    }
    enqueueSpeak(() => speakNotification(n));
  });
  console.log("🔔 startNotificationListener: listener attached");
}

export function stopNotificationListener(): void {
  activeSubscription?.remove();
  activeSubscription = null;
  console.log("🔔 stopNotificationListener: stopped");
}

export function isNotificationListenerRunning(): boolean {
  return activeSubscription !== null;
}
