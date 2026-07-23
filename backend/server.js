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

app.post("/api/assistant", upload.single("audio"), async (req, res) => {
  let ws;
  const t0 = Date.now();
  const elapsed = () => `${Date.now() - t0}ms`;
  try {
    if (!req.file) return res.status(400).json({ error: "No audio provided" });
    console.log(`⏱ [${elapsed()}] request received, audio bytes: ${req.file.buffer.length}`);

    let knownContactNames = [];
    try {
      knownContactNames = JSON.parse(req.body.knownContactNames || "[]");
    } catch {}

    const pcmIn = await convertToPcm16k(req.file.buffer);
    console.log(`⏱ [${elapsed()}] ffmpeg conversion done, pcm bytes: ${pcmIn.length}`);

    let resultIntent = null;
    const audioChunks = [];
    let inputTranscript = "";
    let outputTranscript = "";
    let audioSent = false;
    let firstAudioChunkAt = null;
    let resolved = false;

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {

  console.log(`❌ [${elapsed()}] Gemini timeout`);

  try {
    ws?.close();
  } catch {}

  reject(new Error("gemini_timeout"));

}, 60000);
      ws = new WebSocket(GEMINI_WS_URL);
      console.log(`⏱ [${elapsed()}] opening Gemini websocket`);

      ws.on("open", () => {
        console.log(`⏱ [${elapsed()}] websocket open, sending setup`);
        ws.send(
          JSON.stringify({
            setup: {
              model: `models/${GEMINI_MODEL}`,
              generationConfig: {
  responseModalities: ["AUDIO"],
  speechConfig: {
    voiceConfig: {
      prebuiltVoiceConfig: {
        voiceName: "Kore"
      }
    }
  },
  // gemini-2.5-flash-native-audio models have dynamic thinking ON by
  // default, which spends real time on internal reasoning tokens before
  // producing any audio — noticeable latency for zero benefit on a task
  // like "confirm the reminder" or "call this contact". Turn it off.
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
        console.log(`🔥 [${elapsed()}] Gemini RAW:`, raw.toString().slice(0,500));
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }

        if ((msg.setupComplete || msg.sessionResumptionUpdate) && !audioSent) {
audioSent = true;
  console.log(`⏱ [${elapsed()}] setupComplete received, sending PCM bytes:`, pcmIn.length);

  // Automatic VAD is disabled above, so we own the turn boundary: mark
  // activityStart, send the whole clip, then activityEnd. (audioStreamEnd
  // is for pausing a live stream and isn't used in this manual-VAD mode.)
  ws.send(JSON.stringify({ realtimeInput: { activityStart: {} } }));
  ws.send(
    JSON.stringify({
      realtimeInput: {
        audio: {
          data: pcmIn.toString("base64"),
          mimeType: "audio/pcm;rate=16000"
        },
      },
    })
  );
  ws.send(JSON.stringify({ realtimeInput: { activityEnd: {} } }));

  return;
}

        if (msg.toolCall?.functionCalls?.length) {
          const call = msg.toolCall.functionCalls[0];
          resultIntent = { type: call.name, ...call.args };
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
                console.log(`⏱ [${firstAudioChunkAt}] first audio chunk from Gemini (time-to-first-byte)`);
              }
              audioChunks.push(Buffer.from(part.inlineData.data, "base64"));
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
        // end-of-turn bookkeeping (usageMetadata etc.) we don't need. All the
        // audio chunks and transcription for this turn have already arrived
        // by generationComplete, so there's no reason to sit and wait for
        // turnComplete too — that gap was pure dead time on every request.
        if ((msg.serverContent?.generationComplete || msg.serverContent?.turnComplete) && !resolved) {
          resolved = true;
          console.log(`⏱ [${elapsed()}] turn done (${msg.serverContent?.generationComplete ? "generationComplete" : "turnComplete"}), total audio chunks: ${audioChunks.length}`);
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
    }

    const wavOut = pcmToWav(Buffer.concat(audioChunks), 24000);
    console.log(`⏱ [${elapsed()}] sending response to client, wav bytes: ${wavOut.length}`);

    res.json({
      intent: resultIntent,
      audioBase64: wavOut.toString("base64"),
      transcript: inputTranscript,
    });
  } catch (err) {
    console.error("assistant error:", err);
    try {
      ws?.close();
    } catch {}
    res.status(500).json({ error: "assistant_failed" });
  }
});

app.post("/api/speak", async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || typeof text !== "string" || text.length > 500) {
      return res.status(400).json({ error: "invalid_text" });
    }

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
      console.error("Gemini TTS failed:", errText);
      return res.status(502).json({ error: "tts_failed" });
    }

    const data = await ttsRes.json();
    const base64Pcm = data.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!base64Pcm) return res.status(502).json({ error: "tts_no_audio" });

    const wavOut = pcmToWav(Buffer.from(base64Pcm, "base64"), 24000);
    res.set("Content-Type", "audio/wav");
    res.send(wavOut);
  } catch (err) {
    console.error("speak error:", err);
    res.status(500).json({ error: "tts_failed" });
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

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Sahayogi backend running on port ${port}`));