import { Audio } from "expo-av";
import * as FileSystem from "expo-file-system";

// Converts raw audio bytes to a base64 string in chunks, avoiding call-stack
// limits that can happen from spreading very large arrays at once.
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

// SECURITY NOTE: This file never contains an API key. Every network call goes
// to YOUR_BACKEND_URL, which is your own server (see /backend). Your server
// holds the real Sarvam/ElevenLabs/Narakeet keys and forwards requests. If you
// ever see yourself pasting an API key into this file, stop — put it in the
// backend's .env instead.

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

  // Stops recording, uploads to the backend for transcription, returns Nepali text.
  async stopAndTranscribe(): Promise<string> {
    if (!recording) throw new Error("No active recording");
    await recording.stopAndUnloadAsync();
    const uri = recording.getURI();
    recording = null;
    if (!uri) throw new Error("Recording produced no file");

    const formData = new FormData();
    formData.append("audio", {
      uri,
      name: "speech.m4a",
      type: "audio/m4a",
    } as unknown as Blob);

    const res = await fetch(`${BACKEND_URL}/api/transcribe`, {
      method: "POST",
      body: formData,
      headers: { "Content-Type": "multipart/form-data" },
    });

    if (!res.ok) throw new Error(`Transcription failed: ${res.status}`);
    const data = await res.json();
    return data.transcript as string;
  },

  // Sends Nepali text to the backend for TTS. The backend now streams back
  // the actual audio bytes directly (not a URL), so we save them to a
  // temporary local file and play from there.
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
    await FileSystem.writeAsStringAsync(fileUri, base64Audio, {
      encoding: FileSystem.EncodingType.Base64,
    });

    const { sound } = await Audio.Sound.createAsync({ uri: fileUri });
    await sound.playAsync();
  },
};