// Sahayogi backend — the only place API keys live.
//
// SECURITY CHECKLIST implemented here:
// 1. Helmet for standard HTTP security headers.
// 2. Rate limiting per IP, since this app has no user login/auth — a phone
//    app calling this backend directly is a common abuse target.
// 3. CORS locked to nothing (mobile apps don't send an Origin header the way
//    browsers do, so we don't need to allow one — this blocks stray browser
//    access to the API).
// 4. Uploaded audio is processed in memory and never written to disk.
// 5. The LLM is only ever asked to return one of a FIXED set of intents as
//    JSON — never asked to "do anything" — which both improves reliability
//    for this audience and closes off prompt-injection-driven surprises.
// 6. Caregiver pairing codes are short-lived, single-use, and random —
//    never a shared password.
//
// Deploy this on Render, Railway, Fly.io, or your own VPS with HTTPS
// (all of the above provide free TLS certs automatically).

require("dotenv").config();
const express = require("express");
const multer = require("multer");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const fetch = require("node-fetch");
const crypto = require("crypto");

const app = express();
app.use(helmet());
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 30, // 30 requests/minute/IP is generous for one elderly user's app usage
    standardHeaders: true,
  })
);

// In-memory pairing store for the scaffold. Replace with Redis or a small DB
// table in production so codes survive a server restart.
const pairingCodes = new Map();

// ---- Speech to text ----
app.post("/api/transcribe", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No audio provided" });

    // Example using Sarvam AI's Nepali ASR. Swap for whichever provider you
    // settle on — the important part is that the key lives in process.env,
    // never in the mobile app.
    const sarvamRes = await fetch("https://api.sarvam.ai/speech-to-text", {
      method: "POST",
      headers: { "api-subscription-key": process.env.SARVAM_API_KEY },
      body: (() => {
        const form = new (require("form-data"))();
        form.append("file", req.file.buffer, { filename: "speech.m4a" });
        form.append("language_code", "ne-NP");
        return form;
      })(),
    });

    const data = await sarvamRes.json();
    // req.file.buffer is never written to disk and goes out of scope here —
    // nothing to clean up.
    res.json({ transcript: data.transcript ?? "" });
  } catch (err) {
    console.error("transcribe error:", err);
    res.status(500).json({ error: "transcription_failed" });
  }
});

// ---- Text to speech ----
app.post("/api/speak", async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || typeof text !== "string" || text.length > 1000) {
      return res.status(400).json({ error: "invalid_text" });
    }

    // Swap in your chosen TTS provider's real call here. Returning a signed
    // URL to the generated audio (from provider or your own object storage)
    // is typical — shown here as a placeholder shape.
    const ttsRes = await fetch("https://api.elevenlabs.io/v1/text-to-speech/nepali-voice-id", {
      method: "POST",
      headers: {
        "xi-api-key": process.env.ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text, model_id: "eleven_multilingual_v2" }),
    });

    // In production: stream ttsRes.body to your own storage bucket and
    // return a short-lived signed URL, rather than proxying raw bytes here.
    const audioUrl = ttsRes.headers.get("x-generated-audio-url") ?? null;
    res.json({ audioUrl });
  } catch (err) {
    console.error("speak error:", err);
    res.status(500).json({ error: "tts_failed" });
  }
});

// ---- Intent interpretation via Claude ----
app.post("/api/interpret", async (req, res) => {
  try {
    const { transcript, knownContactNames } = req.body;
    if (!transcript || typeof transcript !== "string" || transcript.length > 500) {
      return res.status(400).json({ error: "invalid_transcript" });
    }

    const systemPrompt = `You interpret spoken Nepali requests from an elderly or disabled user of a voice assistant app. You must respond with ONLY valid JSON matching exactly one of these shapes, nothing else:

{"type":"set_reminder","medicineName":"...","hour":0-23,"minute":0-59}
{"type":"call_contact","contactName":"..."}
{"type":"ask_question","question":"...","answer":"<short spoken Nepali answer, 2-3 sentences max>"}
{"type":"unclear","transcript":"..."}

Known contacts the user might mean: ${JSON.stringify(knownContactNames ?? [])}
If the request doesn't clearly match set_reminder or call_contact, and it's a general question, use ask_question and answer briefly and simply in Nepali. If genuinely ambiguous, use "unclear".`;

    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 300,
        system: systemPrompt,
        messages: [{ role: "user", content: transcript }],
      }),
    });

    const data = await claudeRes.json();
    const text = data.content?.[0]?.text ?? "{}";

    let intent;
    try {
      intent = JSON.parse(text.replace(/```json|```/g, "").trim());
    } catch {
      intent = { type: "unclear", transcript };
    }

    res.json(intent);
  } catch (err) {
    console.error("interpret error:", err);
    res.status(500).json({ type: "unclear", transcript: req.body?.transcript ?? "" });
  }
});

// ---- Caregiver pairing ----
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
