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

// HIGH_QUALITY records 44.1kHz stereo at 128kbps — tuned for music, not
// speech, and the backend immediately downsamples everything to 16kHz mono
// PCM anyway (see convertToPcm16k in server.js). Recording at that same
// 16kHz/mono/low-bitrate target directly means a much smaller file with no
// loss of anything the backend actually uses, which is the single biggest
// lever on upload time over a mobile connection.
const SPEECH_RECORDING_OPTIONS: Audio.RecordingOptions = {
  isMeteringEnabled: true,
  android: {
    extension: ".m4a",
    outputFormat: Audio.AndroidOutputFormat.MPEG_4,
    audioEncoder: Audio.AndroidAudioEncoder.AAC,
    sampleRate: 16000,
    numberOfChannels: 1,
    bitRate: 48000,
  },
  ios: {
    extension: ".m4a",
    outputFormat: Audio.IOSOutputFormat.MPEG4AAC,
    audioQuality: Audio.IOSAudioQuality.MEDIUM,
    sampleRate: 16000,
    numberOfChannels: 1,
    bitRate: 48000,
    linearPCMBitDepth: 16,
    linearPCMIsBigEndian: false,
    linearPCMIsFloat: false,
  },
  web: {
    mimeType: "audio/webm",
    bitsPerSecond: 48000,
  },
};

export interface StreamingPlayer {
  // Queue a base64-encoded WAV segment for playback. Plays immediately if
  // nothing else is currently playing, otherwise queues behind what's
  // already playing/queued.
  pushChunk(base64Wav: string): void;
  // Call once the server has said no more chunks are coming. Resolves once
  // everything already queued has actually finished playing — this is what
  // the caller should await before considering the reply "done".
  finish(): Promise<void>;
}

// expo-av's Sound API loads and plays one complete source at a time — there's
// no "append to a currently-playing stream" primitive. This fakes streaming
// by playing a queue of small WAV segments back-to-back: as soon as one
// finishes, the next (if already arrived) starts immediately. Not
// sample-accurate gapless audio, but close enough to feel live, and it lets
// playback start on the first segment instead of waiting for the full reply.
export function createStreamingPlayer(): StreamingPlayer {
  const queue: string[] = [];
  let playing = false;
  let finished = false;
  let onAllDone: (() => void) | null = null;

  function checkDone() {
    if (finished && !playing && queue.length === 0) {
      onAllDone?.();
      onAllDone = null;
    }
  }

  async function playNext() {
    if (playing) return;
    const next = queue.shift();
    if (!next) {
      checkDone();
      return;
    }
    playing = true;
    try {
      const fileUri = `${FileSystem.cacheDirectory}speech-seg-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2)}.wav`;
      await FileSystem.writeAsStringAsync(fileUri, next, { encoding: "base64" });
      const { sound } = await Audio.Sound.createAsync({ uri: fileUri }, { shouldPlay: true });
      sound.setOnPlaybackStatusUpdate((status) => {
        if (status.isLoaded && status.didJustFinish) {
          sound.unloadAsync().catch(() => {});
          playing = false;
          playNext();
        }
      });
    } catch (err) {
      console.warn("streaming player: segment failed, skipping", err);
      playing = false;
      playNext();
    }
  }

  return {
    pushChunk(base64Wav: string) {
      if (!base64Wav) return;
      queue.push(base64Wav);
      playNext();
    },
    finish() {
      finished = true;
      return new Promise<void>((resolve) => {
        onAllDone = resolve;
        checkDone();
      });
    },
  };
}

export const voiceService = {
  async requestPermission(): Promise<boolean> {
    const { status } = await Audio.requestPermissionsAsync();
    return status === "granted";
  },

  async startRecording(): Promise<void> {
    await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
    const { recording: rec } = await Audio.Recording.createAsync(SPEECH_RECORDING_OPTIONS);
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