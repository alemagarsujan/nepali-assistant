import { Audio } from "expo-av";

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
  // Audio is sent over HTTPS and the backend is instructed to discard the file
  // immediately after transcription (see backend/server.js) unless the user has
  // opted into "help improve accuracy" data sharing.
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

  // Sends Nepali text to the backend for TTS, returns a playable audio URL.
  async speak(text: string): Promise<void> {
    const res = await fetch(`${BACKEND_URL}/api/speak`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error(`TTS failed: ${res.status}`);
    const { audioUrl } = await res.json();

    const { sound } = await Audio.Sound.createAsync({ uri: audioUrl });
    await sound.playAsync();
  },
};
