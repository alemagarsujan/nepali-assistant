import * as FileSystem from "expo-file-system/legacy";
import { AssistantIntent } from "../types";

const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL ?? "https://nepali-assistant.onrender.com";
const WS_BACKEND_URL = BACKEND_URL.replace(/^http/, "ws");

export interface AssistantResult {
  intent: AssistantIntent;
  audioBase64: string; // WAV, ready to hand to voiceService.playAudioBase64
}

export interface StreamingHandlers {
  onIntent: (intent: AssistantIntent) => void;
  // Each call is one standalone, independently-playable WAV segment,
  // base64-encoded — hand these straight to
  // voiceService.createStreamingPlayer()'s pushChunk as they arrive. The
  // backend sends exactly two: a short ~3s one to start playback quickly,
  // then everything else as one final segment, so there's only one
  // handoff point per reply instead of several.
  onAudioChunk: (base64Wav: string) => void;
  onDone: () => void;
  onError: (err: Error) => void;
}

export interface LiveConnection {
  // Send one chunk of raw 16kHz mono PCM captured from the mic, as soon as
  // it's captured — don't wait for recording to finish.
  pushMicChunk(base64Pcm: string): void;
  // Call when the user releases the button — tells the backend to close out
  // the Gemini turn (activityEnd). Reply audio/intent/done still arrive via
  // the handlers passed to connectLive() after this.
  stop(): void;
  // Force-close the connection (e.g. on error/unmount).
  close(): void;
}

// Replaces llmService.ts. Where the old flow was three separate calls
// (transcribe -> interpret -> speak, each a full round trip), this is one:
// upload the recording, get back the structured intent AND the spoken
// Nepali confirmation/answer in a single response. The backend does the
// Gemini Live turn and handles converting formats either direction, so this
// file stays as simple as the old llmService.ts was.
export const assistantService = {
  async send(recordingUri: string, knownContactNames: string[]): Promise<AssistantResult> {
    const formData = new FormData();
    formData.append("audio", {
      uri: recordingUri,
      name: "speech.m4a",
      type: "audio/m4a",
    } as unknown as Blob);
    formData.append("knownContactNames", JSON.stringify(knownContactNames));

    // Timing instrumentation: fetch() resolving marks "response headers +
    // body received" — for our JSON response that's effectively when the
    // whole thing has arrived. Comparing this to the backend's own
    // "sending response to client" log tells us how much of the total time
    // is upload + network vs. the backend's own processing.
    const t0 = Date.now();
    console.log(`⏱ [client] uploading recording...`);

    // Don't set Content-Type manually here — fetch needs to generate its own
    // multipart boundary from the FormData object. A hardcoded
    // "multipart/form-data" header has no boundary parameter, so multer on
    // the backend can't parse the body and req.file ends up empty/undefined.
    const res = await fetch(`${BACKEND_URL}/api/assistant`, {
      method: "POST",
      body: formData,
    });
    console.log(`⏱ [client] response received after ${Date.now() - t0}ms (status ${res.status})`);

    if (!res.ok) {
      return { intent: { type: "unclear", transcript: "" }, audioBase64: "" };
    }

    const result = (await res.json()) as AssistantResult;
    console.log(`⏱ [client] response parsed after ${Date.now() - t0}ms total`);
    return result;
  },

  // Streaming variant of send(): same request, but the backend pushes the
  // reply as a sequence of small playable WAV segments over a WebSocket as
  // Gemini generates them, instead of one big blob after the whole reply is
  // done. Combined with voiceService.createStreamingPlayer(), this lets
  // playback start at roughly "time to first audio segment" (a few seconds)
  // instead of "time to full reply" (several more seconds on top of that).
  sendStreaming(recordingUri: string, knownContactNames: string[], handlers: StreamingHandlers): void {
    const t0 = Date.now();

    (async () => {
      let ws: WebSocket | null = null;
      try {
        const audioBase64 = await FileSystem.readAsStringAsync(recordingUri, { encoding: "base64" });
        console.log(`⏱ [client] recording read as base64 after ${Date.now() - t0}ms`);

        ws = new WebSocket(`${WS_BACKEND_URL}/ws/assistant`);

        ws.onopen = () => {
          console.log(`⏱ [client] ws open after ${Date.now() - t0}ms, sending request`);
          ws!.send(JSON.stringify({ type: "assistant_request", audioBase64, knownContactNames }));
        };

        ws.onmessage = (event) => {
          let msg: any;
          try {
            msg = JSON.parse(event.data as string);
          } catch {
            return;
          }
          switch (msg.type) {
            case "intent":
              handlers.onIntent(msg.intent as AssistantIntent);
              break;
            case "audio_chunk":
              console.log(`⏱ [client] audio segment received after ${Date.now() - t0}ms`);
              handlers.onAudioChunk(msg.data as string);
              break;
            case "done":
              console.log(`⏱ [client] stream done after ${Date.now() - t0}ms`);
              handlers.onDone();
              ws?.close();
              break;
            case "error":
              handlers.onError(new Error(msg.error ?? "assistant_failed"));
              ws?.close();
              break;
          }
        };

        ws.onerror = () => {
          handlers.onError(new Error("assistant_ws_error"));
        };
      } catch (err) {
        ws?.close();
        handlers.onError(err instanceof Error ? err : new Error(String(err)));
      }
    })();
  },

  // True live variant: opens the connection and tells the backend to start
  // talking to Gemini immediately (on record-start, not record-stop), then
  // lets the caller push mic chunks as voiceService.startNativeMicStream()
  // produces them. Only usable when voiceService.isNativeMicStreamingAvailable
  // is true — this needs real-time mic access that Expo Go doesn't have.
  // Reply audio (onAudioChunk) still arrives as WAV segments, same as
  // sendStreaming() — only the input side is genuinely live here.
  connectLive(knownContactNames: string[], handlers: StreamingHandlers): LiveConnection {
    const t0 = Date.now();
    const ws = new WebSocket(`${WS_BACKEND_URL}/ws/assistant-live`);

    ws.onopen = () => {
      console.log(`⏱ [client] live ws open after ${Date.now() - t0}ms, starting turn`);
      ws.send(JSON.stringify({ type: "start", knownContactNames }));
    };

    ws.onmessage = (event) => {
      let msg: any;
      try {
        msg = JSON.parse(event.data as string);
      } catch {
        return;
      }
      switch (msg.type) {
        case "intent":
          handlers.onIntent(msg.intent as AssistantIntent);
          break;
        case "audio_chunk":
          console.log(`⏱ [client] live reply segment received after ${Date.now() - t0}ms`);
          handlers.onAudioChunk(msg.data as string);
          break;
        case "done":
          console.log(`⏱ [client] live stream done after ${Date.now() - t0}ms`);
          handlers.onDone();
          ws.close();
          break;
        case "error":
          handlers.onError(new Error(msg.error ?? "assistant_failed"));
          ws.close();
          break;
      }
    };

    ws.onerror = () => {
      handlers.onError(new Error("assistant_live_ws_error"));
    };

    return {
      pushMicChunk(base64Pcm: string) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "audio_chunk_in", data: base64Pcm }));
        }
      },
      stop() {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "stop" }));
        }
      },
      close() {
        ws.close();
      },
    };
  },
};
