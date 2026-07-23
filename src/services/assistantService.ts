import { AssistantIntent } from "../types";

const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL ?? "https://nepali-assistant.onrender.com";

export interface AssistantResult {
  intent: AssistantIntent;
  audioBase64: string; // WAV, ready to hand to voiceService.playAudioBase64
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
};
