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

// iOS routes audio to the earpiece (the quiet speaker you hold to your ear
// for calls) instead of the main loudspeaker whenever the session category
// is "PlayAndRecord" — which is exactly what allowsRecordingIOS: true sets
// during startRecording(). If that mode is still active when playback
// happens, replies come out of the earpiece instead of the speaker. Switch
// back to a playback-only session before playing anything; startRecording()
// switches it back to recording mode for the next turn.
async function ensurePlaybackAudioMode(): Promise<void> {
  await Audio.setAudioModeAsync({
    allowsRecordingIOS: false,
    playsInSilentModeIOS: true,
    playThroughEarpieceAndroid: false,
  });
}

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

async function loadSegment(base64Wav: string): Promise<Audio.Sound> {
  const fileUri = `${FileSystem.cacheDirectory}speech-seg-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}.wav`;
  await FileSystem.writeAsStringAsync(fileUri, base64Wav, { encoding: "base64" });
  const { sound } = await Audio.Sound.createAsync({ uri: fileUri }, { shouldPlay: false });
  return sound;
}

// expo-av's Sound API loads and plays one complete source at a time — there's
// no "append to a currently-playing stream" primitive. This fakes streaming
// by playing a queue of WAV segments back-to-back, double-buffered: the next
// segment is written to disk and decoded in the background while the
// current one plays, so by the time the current one finishes, the next is
// already fully loaded and playAsync() can be called immediately — no file
// I/O or decode work left to do on the critical path.
//
// An earlier version tried to additionally start the next segment ~150ms
// *before* the current one actually finished, to hide the small amount of
// native player start-up latency that's left even with preloading. That was
// wrong: unlike music, these segments are arbitrary slices of one
// continuous sentence, so overlapping them means playing two different
// parts of the same speech at once — which sounds like two overlapping
// voices, not a smooth blend. Removed; segments now only ever play one at a
// time, transitioning as soon as the current one reports didJustFinish.
export function createStreamingPlayer(): StreamingPlayer {
  const queue: string[] = [];
  let current: Audio.Sound | null = null;
  let preloaded: Audio.Sound | null = null;
  let preloading = false;
  let finished = false;
  let onAllDone: (() => void) | null = null;
  const modeReady = ensurePlaybackAudioMode();

  function checkDone() {
    if (finished && !current && !preloaded && !preloading && queue.length === 0) {
      onAllDone?.();
      onAllDone = null;
    }
  }

  async function ensurePreload() {
    if (preloaded || preloading || queue.length === 0) return;
    preloading = true;
    const next = queue.shift()!;
    try {
      await modeReady;
      preloaded = await loadSegment(next);
    } catch (err) {
      console.warn("streaming player: preload failed, skipping", err);
    } finally {
      preloading = false;
    }
    // If playback ran out and was waiting on this, kick it off now.
    if (!current) advance();
    else ensurePreload(); // keep the pipeline full
  }

  function startCurrent() {
    const sound = preloaded;
    if (!sound) return;
    preloaded = null;
    current = sound;

    sound.setOnPlaybackStatusUpdate((status) => {
      if (!status.isLoaded) return;
      if (status.didJustFinish) {
        sound.unloadAsync().catch(() => {});
        if (current === sound) {
          current = null;
          advance();
        }
        checkDone();
      }
    });

    sound.playAsync().catch((err) => {
      console.warn("streaming player: play failed, skipping", err);
      if (current === sound) current = null;
      advance();
    });
  }

  function advance() {
    if (current) return;
    if (!preloaded) {
      ensurePreload();
      checkDone();
      return;
    }
    startCurrent();
    ensurePreload(); // start getting the one after that ready too
  }

  return {
    pushChunk(base64Wav: string) {
      if (!base64Wav) return;
      queue.push(base64Wav);
      if (!current) advance();
      else ensurePreload();
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
    await ensurePlaybackAudioMode();
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
    await ensurePlaybackAudioMode();
    const fileUri = `${FileSystem.cacheDirectory}speech-${Date.now()}.wav`;
    await FileSystem.writeAsStringAsync(fileUri, base64Audio, { encoding: "base64" });

    const { sound } = await Audio.Sound.createAsync({ uri: fileUri });
    await sound.playAsync();
  },
};