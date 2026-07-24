// Sahayogi backend — the only place API keys live.

require("dotenv").config();
const express = require("express");
const multer = require("multer");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");
const WebSocket = require("ws");

const app = express();
app.use(helmet());
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
  })
);

const pairingCodes = new Map();

// gemini-2.0-flash-live-001 was discontinued (June 2026); this is the current
// Live API model as of this writing. Check https://ai.google.dev/gemini-api/docs/live-guide
// if this starts failing again — Google renames/rotates these periodically.
const GEMINI_MODEL = "gemini-2.5-flash-native-audio-preview-12-2025";
const GEMINI_WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${process.env.GEMINI_API_KEY}`;

function convertToPcm16k(inputBuffer) {
  return new Promise((resolve, reject) => {
    const ff = spawn(ffmpegPath, ["-i", "pipe:0", "-f", "s16le", "-ac", "1", "-ar", "16000", "pipe:1"]);
    const chunks = [];
    ff.stdout.on("data", (d) => chunks.push(d));
    ff.stderr.on("data", () => {});
    ff.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg exited with code ${code}`));
      resolve(Buffer.concat(chunks));
    });
    ff.on("error", reject);
    ff.stdin.write(inputBuffer);
    ff.stdin.end();
  });
}

function pcmToWav(pcmBuffer, sampleRate = 24000) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcmBuffer.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcmBuffer.length, 40);
  return Buffer.concat([header, pcmBuffer]);
}

function buildSystemInstruction(knownContactNames) {
  return [
    "तपाईं 'सहयोगी' नामक आवाज सहायक हुनुहुन्छ, वृद्ध वा असक्षम प्रयोगकर्ताको लागि बनाइएको।",
    "सधैं छोटो, सरल, स्पष्ट नेपालीमा बोल्नुहोस् — २-३ वाक्यभन्दा लामो नबनाउनुहोस्।",
    "यदि प्रयोगकर्ताले औषधि खाने समय राख्न भन्नुभयो भने set_reminder फङ्सन प्रयोग गरेर मौखिक रूपमा पुष्टि गर्नुहोस्।",
    "यदि प्रयोगकर्ताले कसैलाई फोन गर्न भन्नुभयो भने call_contact फङ्सन प्रयोग गरेर पुष्टि गर्नुहोस्।",
    `चिनिएका सम्पर्कहरू: ${knownContactNames.length ? knownContactNames.join(", ") : "कुनै छैन"}।`,
    "अरू सामान्य प्रश्नहरूको लागि फङ्सन प्रयोग नगरी सिधै छोटो जवाफ बोल्नुहोस्।",
  ].join("\n");
}

// Only used by the live endpoint's memory feature. First attempt at giving
// it memory used historyConfig.initialHistoryInClientContent + a replayed
// clientContent message — that made Gemini hang completely (full 60s
// timeout, zero response, not even an error), on every single turn,
// including the very first one with nothing to replay. Whatever the exact
// cause, that specialized history-exchange mechanism isn't safe to use with
// this model. Folding the same history into plain system-instruction text
// instead is a far older, more basic mechanism that every model reliably
// supports — less elegant, but it doesn't risk breaking the turn entirely.
function buildLiveSystemInstruction(knownContactNames, history) {
  const base = buildSystemInstruction(knownContactNames);
  if (!history.length) return base;
  const transcript = history
    .map((h) => `${h.role === "user" ? "प्रयोगकर्ता" : "सहायक"}: ${h.text}`)
    .join("\n");
  return `${base}\n\nअघिल्लो कुराकानी (सन्दर्भको लागि, यसलाई फेरि नदोहोर्याउनुहोस्):\n${transcript}`;
}

const ASSISTANT_TOOLS = [
  {
    functionDeclarations: [
      {
        name: "set_reminder",
        description: "Schedule a daily medicine reminder at a specific time",
        parameters: {
          type: "OBJECT",
          properties: {
            medicineName: { type: "STRING" },
            hour: { type: "INTEGER", description: "0-23" },
            minute: { type: "INTEGER", description: "0-59" },
          },
          required: ["medicineName", "hour", "minute"],
        },
      },
      {
        name: "call_contact",
        description: "Place a phone call to a known contact",
        parameters: {
          type: "OBJECT",
          properties: { contactName: { type: "STRING" } },
          required: ["contactName"],
        },
      },
    ],
  },
];

// Talks to Gemini Live for one turn: uploads the already-16kHz-PCM audio,
// waits for the reply, and reports back through callbacks as things happen
// rather than only at the very end. Both the original one-shot HTTP endpoint
// and the new streaming WebSocket endpoint below share this — the HTTP path
// just buffers everything the callbacks hand it (identical to the old
// inline behavior), the WS path forwards it to the client immediately.
async function runAssistantTurn(rawAudioBuffer, knownContactNames, { onAudioChunk, onIntent, log } = {}) {
  const logLine = log || (() => {});
  let ws;
  const t0 = Date.now();
  const elapsed = () => `${Date.now() - t0}ms`;

  const pcmIn = await convertToPcm16k(rawAudioBuffer);
  logLine(`⏱ [${elapsed()}] ffmpeg conversion done, pcm bytes: ${pcmIn.length}`);

  let resultIntent = null;
  let inputTranscript = "";
  let outputTranscript = "";
  let audioSent = false;
  let firstAudioChunkAt = null;
  let resolved = false;

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      logLine(`❌ [${elapsed()}] Gemini timeout`);
      try {
        ws?.close();
      } catch {}
      reject(new Error("gemini_timeout"));
    }, 60000);
    ws = new WebSocket(GEMINI_WS_URL);
    logLine(`⏱ [${elapsed()}] opening Gemini websocket`);

    ws.on("open", () => {
      logLine(`⏱ [${elapsed()}] websocket open, sending setup`);
      ws.send(
        JSON.stringify({
          setup: {
            model: `models/${GEMINI_MODEL}`,
            generationConfig: {
              responseModalities: ["AUDIO"],
              speechConfig: {
                voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } },
              },
              // gemini-2.5-flash-native-audio models have dynamic thinking ON
              // by default, which spends real time on internal reasoning
              // tokens before producing any audio — noticeable latency for
              // zero benefit on a task like "confirm the reminder". Off.
              thinkingConfig: { thinkingBudget: 0 },
            },
            systemInstruction: { parts: [{ text: buildSystemInstruction(knownContactNames) }] },
            tools: ASSISTANT_TOOLS,
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            // We upload one complete pre-recorded clip per request, not a
            // live mic stream, so let us mark the turn boundary explicitly
            // instead of relying on server-side VAD to detect end-of-speech
            // from trailing silence in the clip (unreliable, and was the
            // cause of requests hanging until timeout with no response at
            // all — see https://ai.google.dev/gemini-api/docs/live-guide#disable-automatic-vad).
            realtimeInputConfig: {
              automaticActivityDetection: { disabled: true },
            },
          },
        })
      );
    });

    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if ((msg.setupComplete || msg.sessionResumptionUpdate) && !audioSent) {
        audioSent = true;
        logLine(`⏱ [${elapsed()}] setupComplete received, sending PCM bytes: ${pcmIn.length}`);

        // Automatic VAD is disabled above, so we own the turn boundary: mark
        // activityStart, send the whole clip, then activityEnd.
        ws.send(JSON.stringify({ realtimeInput: { activityStart: {} } }));
        ws.send(
          JSON.stringify({
            realtimeInput: {
              audio: { data: pcmIn.toString("base64"), mimeType: "audio/pcm;rate=16000" },
            },
          })
        );
        ws.send(JSON.stringify({ realtimeInput: { activityEnd: {} } }));
        return;
      }

      if (msg.toolCall?.functionCalls?.length) {
        const call = msg.toolCall.functionCalls[0];
        resultIntent = { type: call.name, ...call.args };
        onIntent?.(resultIntent);
        ws.send(
          JSON.stringify({
            toolResponse: {
              functionResponses: [{ id: call.id, name: call.name, response: { result: "ok" } }],
            },
          })
        );
      }

      if (msg.serverContent?.modelTurn?.parts) {
        for (const part of msg.serverContent.modelTurn.parts) {
          if (part.inlineData?.data) {
            if (!firstAudioChunkAt) {
              firstAudioChunkAt = elapsed();
              logLine(`⏱ [${firstAudioChunkAt}] first audio chunk from Gemini (time-to-first-byte)`);
            }
            onAudioChunk?.(Buffer.from(part.inlineData.data, "base64"));
          }
        }
      }

      if (msg.serverContent?.inputTranscription?.text) {
        inputTranscript += msg.serverContent.inputTranscription.text;
      }
      if (msg.serverContent?.outputTranscription?.text) {
        outputTranscript += msg.serverContent.outputTranscription.text;
      }

      // generationComplete fires when Gemini is done producing audio/text
      // for this turn — turnComplete follows ~2-2.5s later and just adds
      // end-of-turn bookkeeping (usageMetadata etc.) we don't need.
      if ((msg.serverContent?.generationComplete || msg.serverContent?.turnComplete) && !resolved) {
        resolved = true;
        logLine(`⏱ [${elapsed()}] turn done (${msg.serverContent?.generationComplete ? "generationComplete" : "turnComplete"})`);
        clearTimeout(timeout);
        resolve();
      }
    });

    ws.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });

  ws.close();

  if (!resultIntent) {
    resultIntent = outputTranscript
      ? { type: "ask_question", question: inputTranscript, answer: outputTranscript }
      : { type: "unclear", transcript: inputTranscript };
    onIntent?.(resultIntent);
  }

  return { intent: resultIntent, transcript: inputTranscript };
}

app.post("/api/assistant", upload.single("audio"), async (req, res) => {
  const t0 = Date.now();
  const elapsed = () => `${Date.now() - t0}ms`;
  try {
    if (!req.file) return res.status(400).json({ error: "No audio provided" });
    console.log(`⏱ [${elapsed()}] request received, audio bytes: ${req.file.buffer.length}`);

    let knownContactNames = [];
    try {
      knownContactNames = JSON.parse(req.body.knownContactNames || "[]");
    } catch {}

    const audioChunks = [];
    const { intent, transcript } = await runAssistantTurn(req.file.buffer, knownContactNames, {
      onAudioChunk: (chunk) => audioChunks.push(chunk),
      log: (line) => console.log(line),
    });

    const wavOut = pcmToWav(Buffer.concat(audioChunks), 24000);
    console.log(`⏱ [${elapsed()}] sending response to client, wav bytes: ${wavOut.length}`);

    res.json({ intent, audioBase64: wavOut.toString("base64"), transcript });
  } catch (err) {
    console.error("assistant error:", err);
    res.status(500).json({ error: "assistant_failed" });
  }
});

// Shared by /api/speak and /api/notify-speak — takes Nepali (or any) text,
// returns a ready-to-play WAV Buffer. Throws on failure; callers decide the
// HTTP response.
async function synthesizeSpeech(text) {
  const ttsRes = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text }] }],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } } },
        },
      }),
    }
  );

  if (!ttsRes.ok) {
    const errText = await ttsRes.text();
    throw new Error(`Gemini TTS failed: ${errText}`);
  }

  const data = await ttsRes.json();
  const base64Pcm = data.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  if (!base64Pcm) throw new Error("Gemini TTS returned no audio");

  return pcmToWav(Buffer.from(base64Pcm, "base64"), 24000);
}

app.post("/api/speak", async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || typeof text !== "string" || text.length > 500) {
      return res.status(400).json({ error: "invalid_text" });
    }

    const wavOut = await synthesizeSpeech(text);
    res.set("Content-Type", "audio/wav");
    res.send(wavOut);
  } catch (err) {
    console.error("speak error:", err);
    res.status(500).json({ error: "tts_failed" });
  }
});

// Turns a phone notification (from any app, possibly in English) into one
// short spoken Nepali sentence and returns the audio. Two Gemini calls: a
// plain text one to translate/summarize/phrase it, then TTS on the result
// — this endpoint is for background announcements (see
// notificationService.ts), not a live conversation, so the extra second or
// two of latency compared to the live path doesn't matter here the way it
// would there.
function buildNotificationPrompt(appName, title, text) {
  return [
    "तपाईं एउटा सहायक हुनुहुन्छ जसले फोनमा आएको सूचना (notification) लाई प्रयोगकर्तालाई सुनाउनको लागि एउटै छोटो, बोलिने नेपाली वाक्यमा बदल्नुहुन्छ।",
    "यदि सूचना अंग्रेजी वा अरू भाषामा छ भने नेपालीमा अनुवाद गर्नुहोस्। एप्को नाम पनि उल्लेख गर्नुहोस् (जस्तै: 'व्हाट्सएपबाट...').",
    "जवाफमा एउटै वाक्य मात्र दिनुहोस् — अरू केही नलेख्नुहोस्, व्याख्या नगर्नुहोस्।",
    "",
    `एप: ${appName || "थाहा छैन"}`,
    `शीर्षक: ${title || ""}`,
    `सन्देश: ${text || ""}`,
  ].join("\n");
}

app.post("/api/notify-speak", async (req, res) => {
  try {
    const appName = typeof req.body.appName === "string" ? req.body.appName.slice(0, 100) : "";
    const title = typeof req.body.title === "string" ? req.body.title.slice(0, 300) : "";
    const text = typeof req.body.text === "string" ? req.body.text.slice(0, 1000) : "";
    if (!title && !text) {
      return res.status(400).json({ error: "invalid_notification" });
    }

    const composeRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: buildNotificationPrompt(appName, title, text) }] }],
        }),
      }
    );

    if (!composeRes.ok) {
      const errText = await composeRes.text();
      console.error("notify-speak compose failed:", errText);
      return res.status(502).json({ error: "compose_failed" });
    }

    const composeData = await composeRes.json();
    const spokenText = composeData.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!spokenText) return res.status(502).json({ error: "compose_empty" });

    const wavOut = await synthesizeSpeech(spokenText);
    res.set("Content-Type", "audio/wav");
    res.set("X-Spoken-Text", encodeURIComponent(spokenText));
    res.send(wavOut);
  } catch (err) {
    console.error("notify-speak error:", err);
    res.status(500).json({ error: "notify_speak_failed" });
  }
});

app.post("/api/pairing/create", (req, res) => {
  const code = crypto.randomInt(100000, 999999).toString();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  pairingCodes.set(code, { expiresAt, used: false });
  res.json({ code, expiresAt });
});

app.post("/api/pairing/redeem", (req, res) => {
  const { code } = req.body;
  const entry = pairingCodes.get(code);
  if (!entry || entry.used || new Date(entry.expiresAt) < new Date()) {
    return res.status(400).json({ error: "invalid_or_expired_code" });
  }
  entry.used = true;
  res.json({ paired: true });
});

// Streaming twin of /api/assistant. The HTTP endpoint waits for Gemini's
// entire spoken reply before sending anything back — fine for correctness,
// but it means the phone can't start playing audio until the whole thing
// (several seconds) has been generated AND transferred. Here we push audio
// to the client in ~500ms segments as Gemini produces them, so playback can
// start around "time to first audio byte" instead of "time to full reply".
//
// Segments are buffered to ~1.5s of PCM before being wrapped as a standalone
// WAV and sent. This used to be ~500ms, but every segment boundary costs the
// phone a real native-audio-engine startup delay when it starts playing the
// next clip — with 500ms segments that happens ~15+ times over one reply,
// which is frequent enough to sound like constant stuttering. Bigger
// segments mean far fewer boundaries (a few instead of a dozen+), at the
// cost of a bit more time before the very first segment is ready.
// Every segment boundary is a chance for expo-av's playback handoff to be
// audible as a tiny pause (see voiceService.ts) — there's no way to make a
// handoff perfectly gapless with that API, only fewer of them. So instead of
// many small segments (which was 4-6 handoffs per reply, each a chance to be
// heard), send just ONE small first segment to start playback quickly, then
// buffer everything else into a single final segment. That's one handoff per
// reply, period, no matter how long the reply runs.
const FIRST_SEGMENT_BYTES = 144000; // ~3s of 24kHz mono 16-bit PCM (see pcmToWav)

const port = process.env.PORT || 3000;
const server = app.listen(port, () => console.log(`Sahayogi backend running on port ${port}`));

// noServer + manual pathname dispatch, not `{ server, path }` on each one.
// With two `new WebSocket.Server({ server, path })` instances attached to
// the same HTTP server, Node calls BOTH of their internal 'upgrade'
// listeners for every upgrade request, in registration order. `ws`'s own
// path-mismatch handling (shouldHandle()) responds to a mismatch by writing
// an HTTP 400 and destroying the socket — so the first-registered server
// (streamWss) was aborting every connection meant for liveWss's path before
// liveWss's own listener ever got a chance to run. That's the documented
// "multiple paths on one server" pattern from the ws README — one shared
// upgrade listener, routed by pathname, is the actually-safe version.
const streamWss = new WebSocket.Server({ noServer: true });

streamWss.on("connection", (clientWs) => {
  const t0 = Date.now();
  const elapsed = () => `${Date.now() - t0}ms`;
  const send = (payload) => {
    if (clientWs.readyState === WebSocket.OPEN) clientWs.send(JSON.stringify(payload));
  };

  clientWs.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return send({ type: "error", error: "invalid_message" });
    }
    if (msg.type !== "assistant_request") return;

    try {
      const audioBuffer = Buffer.from(msg.audioBase64 || "", "base64");
      if (!audioBuffer.length) return send({ type: "error", error: "no_audio" });
      console.log(`⏱ [ws ${elapsed()}] request received, audio bytes: ${audioBuffer.length}`);

      let segmentBuf = [];
      let segmentBytes = 0;
      let firstSegmentSent = false;
      const flushSegment = (isFinal) => {
        if (!segmentBytes) return;
        const wavOut = pcmToWav(Buffer.concat(segmentBuf), 24000);
        console.log(`⏱ [ws ${elapsed()}] sending audio segment, wav bytes: ${wavOut.length}${isFinal ? " (final)" : ""}`);
        send({ type: "audio_chunk", data: wavOut.toString("base64") });
        segmentBuf = [];
        segmentBytes = 0;
      };

      const { transcript } = await runAssistantTurn(audioBuffer, msg.knownContactNames || [], {
        log: (line) => console.log(`[ws ${elapsed()}] ${line}`),
        onIntent: (intent) => {
          console.log(`⏱ [ws ${elapsed()}] intent ready: ${intent.type}`);
          send({ type: "intent", intent });
        },
        onAudioChunk: (chunk) => {
          segmentBuf.push(chunk);
          segmentBytes += chunk.length;
          // Only the very first segment flushes early (to start playback
          // quickly); everything after that accumulates into one final
          // segment sent when the turn ends, so there's only one handoff.
          if (!firstSegmentSent && segmentBytes >= FIRST_SEGMENT_BYTES) {
            firstSegmentSent = true;
            flushSegment(false);
          }
        },
      });

      flushSegment(true);
      console.log(`⏱ [ws ${elapsed()}] done`);
      send({ type: "done", transcript });
    } catch (err) {
      console.error("assistant ws error:", err);
      send({ type: "error", error: "assistant_failed" });
    }
  });
});

// True live-streaming twin of /ws/assistant, for phones running a native
// build with real-time mic access (see voiceService.ts's native path — Expo
// Go can't do this, only a dev client build can). The difference from
// /ws/assistant isn't just transport: there, the phone waits until the user
// releases the button, THEN uploads one finished recording, THEN Gemini
// starts listening to any of it. Here, the mic module hands us 16kHz mono
// PCM chunks *while the user is still talking*, already in the exact format
// Gemini wants — no ffmpeg conversion needed — so we open the Gemini
// connection and start feeding it audio immediately. By the time the user
// releases the button, Gemini has usually already processed most of what
// they said, instead of not having heard any of it yet.
//
// Reply audio also goes out differently here than on /ws/assistant: instead
// of a couple of WAV segments played one-at-a-time through expo-av (which
// always has a small handoff gap between segments — that's the "still a
// slight pause" residual from the WAV-segment approach), this forwards raw
// PCM straight to the phone's native two-way-audio module, which plays
// through one continuous audio queue instead of one-file-at-a-time Sound
// objects — no per-segment handoff at all. The catch: that module's player
// is fixed at 16kHz, but Gemini's audio replies are 24kHz, so each reply
// chunk is downsampled through a small persistent ffmpeg process before
// being sent on. See voiceService.ts's createNativePcmPlayer().
const liveWss = new WebSocket.Server({ noServer: true });

// This app is one person talking to their own assistant, not a multi-user
// service — so a single module-level history array is enough to give every
// new turn memory of previous ones, without the client needing to track or
// send anything.
//
// Two earlier attempts at this didn't pan out:
//  1. Gemini's own session-resumption handles (server hands you a token,
//     you pass it into the next connection's setup to restore prior
//     context) — never actually fired in testing, no
//     sessionResumptionUpdate ever arrived within these short turns.
//  2. historyConfig.initialHistoryInClientContent + replaying history as a
//     clientContent message — this model just hung completely (full 60s
//     timeout, zero response) the moment that field was added, even on
//     the very first turn with nothing to replay yet.
// What actually works: fold the transcript straight into the system
// instruction text (see buildLiveSystemInstruction) — the most basic,
// universally-supported mechanism there is, so nothing to silently choke
// on.
let conversationHistory = []; // [{ role: "user" | "model", text }]
const MAX_HISTORY_ENTRIES = 20; // ~10 exchanges — plenty for "what's my name", cheap enough to replay every turn

// One ffmpeg process per connection, fed 24kHz PCM as it arrives from
// Gemini and emitting 16kHz PCM as fast as it can, rather than spawning a
// new process per chunk (which would add real subprocess-startup latency
// to every single chunk instead of once per turn).
function createDownsampler(onChunk) {
  const ff = spawn(ffmpegPath, [
    "-f", "s16le", "-ar", "24000", "-ac", "1", "-i", "pipe:0",
    "-f", "s16le", "-ar", "16000", "-ac", "1", "pipe:1",
  ]);
  ff.stdout.on("data", onChunk);
  ff.stderr.on("data", () => {});
  ff.on("error", (err) => console.error("downsampler error:", err));
  return {
    write(buf) {
      if (!ff.stdin.destroyed) ff.stdin.write(buf);
    },
    // Resolves once ffmpeg has emitted every last resampled byte — the
    // caller needs to wait for this before telling the client the turn is
    // done, otherwise the tail end of the reply could be dropped.
    finish() {
      return new Promise((resolve) => {
        ff.once("close", resolve);
        if (!ff.stdin.destroyed) ff.stdin.end();
        else resolve();
      });
    },
    kill() {
      try {
        ff.kill("SIGKILL");
      } catch {}
    },
  };
}

liveWss.on("connection", (clientWs) => {
  const t0 = Date.now();
  const elapsed = () => `${Date.now() - t0}ms`;
  const send = (payload) => {
    if (clientWs.readyState === WebSocket.OPEN) clientWs.send(JSON.stringify(payload));
  };

  let geminiWs = null;
  let setupDone = false;
  let clientStopped = false;
  let knownContactNames = [];
  const pendingChunks = [];
  let resultIntent = null;
  let inputTranscript = "";
  let outputTranscript = "";
  let resolved = false;
  let timeout = null;

  let repliedBytes = 0;
  const downsampler = createDownsampler((pcm16kChunk) => {
    repliedBytes += pcm16kChunk.length;
    send({ type: "audio_chunk_pcm", data: pcm16kChunk.toString("base64") });
  });

  function openGemini() {
    console.log(
      `⏱ [live ${elapsed()}] opening Gemini websocket, ${conversationHistory.length} history entr${conversationHistory.length === 1 ? "y" : "ies"} to replay`
    );
    geminiWs = new WebSocket(GEMINI_WS_URL);

    timeout = setTimeout(() => {
      console.log(`⏱ [live ${elapsed()}] Gemini timeout`);
      try {
        geminiWs.close();
      } catch {}
      downsampler.kill();
      send({ type: "error", error: "assistant_failed" });
    }, 60000);

    geminiWs.on("open", () => {
      console.log(`⏱ [live ${elapsed()}] websocket open, sending setup`);
      geminiWs.send(
        JSON.stringify({
          setup: {
            model: `models/${GEMINI_MODEL}`,
            generationConfig: {
              responseModalities: ["AUDIO"],
              speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } } },
              thinkingConfig: { thinkingBudget: 0 },
            },
            // Prior turns are folded into the instruction text itself (see
            // buildLiveSystemInstruction) — that's what gives follow-up
            // questions memory of earlier ones.
            systemInstruction: { parts: [{ text: buildLiveSystemInstruction(knownContactNames, conversationHistory) }] },
            tools: ASSISTANT_TOOLS,
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            // Here we genuinely are feeding a live mic stream, chunk by
            // chunk, as it's captured — unlike the other endpoints, manual
            // activityStart/activityEnd (sent below) still gives us an
            // explicit, reliable turn boundary instead of leaning on
            // server-side silence detection.
            realtimeInputConfig: {
              automaticActivityDetection: { disabled: true },
            },
            // Keeps a long-running back-and-forth from eventually hitting
            // the session's context window limit as history accumulates.
            contextWindowCompression: { slidingWindow: {} },
          },
        })
      );
    });

    geminiWs.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if ((msg.setupComplete || msg.sessionResumptionUpdate) && !setupDone) {
        setupDone = true;
        console.log(`⏱ [live ${elapsed()}] setupComplete, flushing ${pendingChunks.length} buffered chunk(s)`);
        geminiWs.send(JSON.stringify({ realtimeInput: { activityStart: {} } }));
        for (const b64 of pendingChunks.splice(0)) {
          geminiWs.send(
            JSON.stringify({ realtimeInput: { audio: { data: b64, mimeType: "audio/pcm;rate=16000" } } })
          );
        }
        if (clientStopped) {
          geminiWs.send(JSON.stringify({ realtimeInput: { activityEnd: {} } }));
        }
        return;
      }

      if (msg.toolCall?.functionCalls?.length) {
        const call = msg.toolCall.functionCalls[0];
        resultIntent = { type: call.name, ...call.args };
        console.log(`⏱ [live ${elapsed()}] intent ready: ${resultIntent.type}`);
        send({ type: "intent", intent: resultIntent });
        geminiWs.send(
          JSON.stringify({
            toolResponse: {
              functionResponses: [{ id: call.id, name: call.name, response: { result: "ok" } }],
            },
          })
        );
      }

      if (msg.serverContent?.modelTurn?.parts) {
        for (const part of msg.serverContent.modelTurn.parts) {
          if (part.inlineData?.data) {
            // Straight into the resampler, no buffering — the whole point
            // is to hand the phone audio as soon as Gemini produces it.
            downsampler.write(Buffer.from(part.inlineData.data, "base64"));
          }
        }
      }

      if (msg.serverContent?.inputTranscription?.text) {
        inputTranscript += msg.serverContent.inputTranscription.text;
      }
      if (msg.serverContent?.outputTranscription?.text) {
        outputTranscript += msg.serverContent.outputTranscription.text;
      }

      if ((msg.serverContent?.generationComplete || msg.serverContent?.turnComplete) && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        console.log(`⏱ [live ${elapsed()}] turn done, flushing downsampler`);
        try {
          geminiWs.close();
        } catch {}

        // This is what actually gives the *next* turn memory of this one —
        // recorded from the same transcripts already used to build
        // resultIntent below, replayed at the start of the next session
        // (see the setupComplete handler above).
        if (inputTranscript.trim()) {
          conversationHistory.push({ role: "user", text: inputTranscript.trim() });
          if (outputTranscript.trim()) {
            conversationHistory.push({ role: "model", text: outputTranscript.trim() });
          }
          if (conversationHistory.length > MAX_HISTORY_ENTRIES) {
            conversationHistory.splice(0, conversationHistory.length - MAX_HISTORY_ENTRIES);
          }
        }

        // Wait for every last resampled byte to actually reach the client
        // before saying we're done — ffmpeg's stdout keeps emitting for a
        // moment after stdin closes.
        downsampler.finish().then(() => {
          console.log(`⏱ [live ${elapsed()}] downsampler flushed, ${repliedBytes} PCM bytes sent`);
          if (!resultIntent) {
            resultIntent = outputTranscript
              ? { type: "ask_question", question: inputTranscript, answer: outputTranscript }
              : { type: "unclear", transcript: inputTranscript };
            send({ type: "intent", intent: resultIntent });
          }
          send({ type: "done", transcript: inputTranscript });
        });
      }
    });

    geminiWs.on("error", (err) => {
      clearTimeout(timeout);
      downsampler.kill();
      console.error("live assistant ws error:", err);
      send({ type: "error", error: "assistant_failed" });
    });
  }

  clientWs.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (msg.type) {
      case "start":
        knownContactNames = msg.knownContactNames || [];
        console.log(`⏱ [live ${elapsed()}] start received`);
        openGemini();
        break;
      case "audio_chunk_in":
        if (!msg.data) return;
        if (setupDone && geminiWs?.readyState === WebSocket.OPEN) {
          geminiWs.send(
            JSON.stringify({ realtimeInput: { audio: { data: msg.data, mimeType: "audio/pcm;rate=16000" } } })
          );
        } else {
          // Setup hasn't finished yet — hold onto it, flushed as soon as
          // setupComplete arrives above.
          pendingChunks.push(msg.data);
        }
        break;
      case "stop":
        clientStopped = true;
        console.log(`⏱ [live ${elapsed()}] stop received`);
        if (setupDone && geminiWs?.readyState === WebSocket.OPEN) {
          geminiWs.send(JSON.stringify({ realtimeInput: { activityEnd: {} } }));
        }
        break;
    }
  });

  clientWs.on("close", () => {
    clearTimeout(timeout);
    downsampler.kill();
    try {
      geminiWs?.close();
    } catch {}
  });
});

// Single shared upgrade handler for both WS servers, dispatching by
// pathname. This is the documented-safe way to run more than one `ws`
// WebSocketServer off the same HTTP server (see the ws README's "multiple
// paths" example) — each server above is created with `noServer: true` so
// it never registers its own competing 'upgrade' listener.
server.on("upgrade", (request, socket, head) => {
  const pathname = request.url.split("?")[0];
  if (pathname === "/ws/assistant") {
    streamWss.handleUpgrade(request, socket, head, (ws) => {
      streamWss.emit("connection", ws, request);
    });
  } else if (pathname === "/ws/assistant-live") {
    liveWss.handleUpgrade(request, socket, head, (ws) => {
      liveWss.emit("connection", ws, request);
    });
  } else {
    socket.destroy();
  }
});