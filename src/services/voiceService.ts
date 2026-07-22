import { Audio } from "expo-av";
import * as FileSystem from "expo-file-system/legacy";

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL ?? "https://nepali-assistant.onrender.com";

let recording: Audio.Recording | null = null;

export const voiceService = {
  async requestPermission(): Promise<boolean> {
    const { status } = await Audio.requestPermissionsAsync();
    return status === "granted";
  },

  async startRecording(): Promise<void> {
    await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
    const { recording: rec } = await Audio.Recording.createAsync(
      Audio.RecordingOptionsPresets.HIGH_QUALITY
    );
    recording = rec;
  },

  async stopRecordingToFile(): Promise<string> {
    if (!recording) throw new Error("No active recording");
    await recording.stopAndUnloadAsync();
    const uri = recording.getURI();
    recording = null;
    if (!uri) throw new Error("Recording produced no file");
    return uri;
  },

  async playAudioBase64(base64Wav: string): Promise<void> {
    if (!base64Wav) return;
    const fileUri = `${FileSystem.cacheDirectory}speech-${Date.now()}.wav`;
    await FileSystem.writeAsStringAsync(fileUri, base64Wav, { encoding: "base64" });
    const { sound } = await Audio.Sound.createAsync({ uri: fileUri });
    await sound.playAsync();
  },

  async speak(text: string): Promise<void> {
    const res = await fetch(`${BACKEND_URL}/api/speak`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error(`TTS failed: ${res.status}`);

    const arrayBuffer = await res.arrayBuffer();
    const base64Audio = arrayBufferToBase64(arrayBuffer);
    const fileUri = `${FileSystem.cacheDirectory}speech-${Date.now()}.wav`;
    await FileSystem.writeAsStringAsync(fileUri, base64Audio, { encoding: "base64" });

    const { sound } = await Audio.Sound.createAsync({ uri: fileUri });
    await sound.playAsync();
  },
};