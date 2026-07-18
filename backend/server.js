// Sahayogi backend — the only place API keys live.

require("dotenv").config();
const express = require("express");
const multer = require("multer");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");

// Node 18+ has fetch, FormData, and Blob built in globally — no packages
// needed for any of this.

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

// ---- Speech to text ----
app.post("/api/transcribe", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No audio provided" });

    const sarvamForm = new FormData();
    sarvamForm.append("file", new Blob([req.file.buffer]), "speech.m4a");
    sarvamForm.append("language", "ne-IN");
    sarvamForm.append("model", "saaras:v3");

    const sarvamRes = await fetch("https://api.sarvam.ai/speech-to-text", {
      method: "POST",
      headers: { "api-subscription-key": process.env.SARVAM_API_KEY },
      body: sarvamForm,
    });

    if (!sarvamRes.ok) {
      const errText = await sarvamRes.text();
      console.error("Sarvam transcribe failed:", errText);
      return res.status(502).json({ error: "transcribe_failed" });
    }

    const data = await sarvamRes.json();
    res.json({ transcript: data.transcript ?? "" });
  } catch (err) {
    console.error("transcribe error:", err);
    res.status(500).json({ error: "transcription_failed" });
  }
});

// ---- Text to speech (CAMB.AI) ----
app.post("/api/speak", async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || typeof text !== "string" || text.length > 1000) {
      return res.status(400).json({ error: "invalid_text" });
    }

    const submitRes = await fetch("https://client.camb.ai/apis/tts", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.CAMB_API_KEY,
      },
      body: JSON.stringify({
        text,
        voice_id: Number(process.env.CAMB_VOICE_ID),
        language: Number(process.env.CAMB_LANGUAGE_ID),
      }),
    });

    if (!submitRes.ok) {
      const errText = await submitRes.text();
      console.error("CAMB submit failed:", errText);
      return res.status(502).json({ error: "tts_submit_failed" });
    }

    const { task_id } = await submitRes.json();

    let runId = null;
    const maxAttempts = 14;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise((r) => setTimeout(r, 1500));
      const statusRes = await fetch(`https://client.camb.ai/apis/tts/${task_id}`, {
        headers: { "x-api-key": process.env.CAMB_API_KEY },
      });
      const statusData = await statusRes.json();
      if (statusData.status === "SUCCESS") {
        runId = statusData.run_id;
        break;
      }
      if (statusData.status === "ERROR" || statusData.status === "TIMEOUT") {
        return res.status(502).json({ error: "tts_generation_failed" });
      }
    }

    if (!runId) {
      return res.status(504).json({ error: "tts_timed_out" });
    }

    const audioRes = await fetch(`https://client.camb.ai/apis/tts-result/${runId}`, {
      headers: { "x-api-key": process.env.CAMB_API_KEY },
    });

    if (!audioRes.ok) {
      const errText = await audioRes.text();
      console.error("CAMB audio fetch failed:", errText);
      return res.status(502).json({ error: "tts_audio_fetch_failed" });
    }

    const audioBuffer = Buffer.from(await audioRes.arrayBuffer());
    res.set("Content-Type", "audio/wav");
    res.send(audioBuffer);
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