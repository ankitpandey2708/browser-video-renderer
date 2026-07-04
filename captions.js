// captions.js  [#5]
// Auto-captions from the page's OWN audio: transcribe (speech-to-text) the
// rendered audio track and write subtitles. On-identity -- we caption what the
// page says, we do not author text. Default engine is local whisper.cpp; OpenAI
// is a cloud fallback. Anthropic is NOT used (Claude has no speech-to-text).
//
//   generateCaptions(audioPath, outVideo, { asr, lang, burn })
//     -> { srt, burned } | { skipped: true }
// Never throws for a missing/failed engine -- logs and returns { skipped } so a
// caption failure never fails the render.

const { execFileSync } = require("child_process");
const fs = require("fs");

// Seconds -> SRT timestamp "HH:MM:SS,mmm".
function fmt(t) {
  const ms = Math.max(0, Math.round(t * 1000));
  const h = String(Math.floor(ms / 3600000)).padStart(2, "0");
  const m = String(Math.floor(ms / 60000) % 60).padStart(2, "0");
  const s = String(Math.floor(ms / 1000) % 60).padStart(2, "0");
  const x = String(ms % 1000).padStart(3, "0");
  return `${h}:${m}:${s},${x}`;
}

// segments: [{ start, end, text }] (seconds) -> SRT file.
function writeSrt(segments, out) {
  const body = segments
    .filter((c) => c && c.text && c.text.trim())
    .map((c, i) => `${i + 1}\n${fmt(c.start)} --> ${fmt(c.end)}\n${c.text.trim()}\n`)
    .join("\n");
  fs.writeFileSync(out, body);
}

// whisper.cpp: binary from WHISPER_CPP (or PATH "whisper-cli"), model from
// WHISPER_MODEL. Emits JSON we map to segments. Throws if the binary is missing.
function transcribeWhisper(audioPath, { lang } = {}) {
  const bin = process.env.WHISPER_CPP || "whisper-cli";
  const model = process.env.WHISPER_MODEL;
  if (!model) throw new Error("set WHISPER_MODEL to a whisper.cpp model file (.bin)");
  const base = audioPath + ".whisper";
  const args = ["-m", model, "-f", audioPath, "-oj", "-of", base];
  if (lang) args.push("-l", lang);
  execFileSync(bin, args, { stdio: "ignore" }); // throws (ENOENT) if bin missing
  const j = JSON.parse(fs.readFileSync(base + ".json", "utf8"));
  try { fs.unlinkSync(base + ".json"); } catch (e) {}
  return (j.transcription || []).map((t) => ({
    start: (t.offsets && t.offsets.from) / 1000 || 0,
    end: (t.offsets && t.offsets.to) / 1000 || 0,
    text: t.text || "",
  }));
}

// OpenAI transcription (cloud fallback). Requires OPENAI_API_KEY. Kept minimal;
// sends the audio off-box.
async function transcribeOpenai(audioPath, { lang } = {}) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("set OPENAI_API_KEY to use --asr openai");
  const form = new FormData();
  form.append("file", new Blob([fs.readFileSync(audioPath)]), "audio.wav");
  form.append("model", "whisper-1");
  form.append("response_format", "verbose_json");
  if (lang) form.append("language", lang);
  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form,
  });
  if (!res.ok) throw new Error(`OpenAI ASR ${res.status}: ${await res.text()}`);
  const j = await res.json();
  return (j.segments || []).map((s) => ({ start: s.start, end: s.end, text: s.text }));
}

async function transcribe(audioPath, { asr = "whisper", lang } = {}) {
  if (asr === "openai") return transcribeOpenai(audioPath, { lang });
  return transcribeWhisper(audioPath, { lang });
}

// Escape an srt path for the ffmpeg subtitles filter (Windows backslashes/colons).
function escSub(p) {
  return p.replace(/\\/g, "/").replace(/:/g, "\\:");
}

// Extract a 16 kHz mono WAV from any media (video or audio) -- the format
// whisper.cpp expects. Returns the temp wav path, or null if there's no audio.
function toWav(mediaPath) {
  const wav = mediaPath.replace(/\.[^./\\]+$/, "") + ".asr.wav";
  try {
    execFileSync("ffmpeg", ["-nostdin", "-y", "-i", mediaPath,
      "-vn", "-ac", "1", "-ar", "16000", "-f", "wav", wav], { stdio: "ignore" });
  } catch (e) { return null; } // no audio stream / ffmpeg error
  return fs.existsSync(wav) ? wav : null;
}

async function generateCaptions(audioPath, outVideo, opts = {}) {
  if (!audioPath || !fs.existsSync(audioPath)) {
    console.log("  (captions skipped: no audio track to transcribe)");
    return { skipped: true };
  }
  // Normalize to the WAV whisper.cpp wants (also lets us caption straight from
  // the finished video). If extraction yields nothing, there's no speech track.
  const wav = audioPath.toLowerCase().endsWith(".wav") ? audioPath : toWav(audioPath);
  if (!wav) {
    console.log("  (captions skipped: no audio track to transcribe)");
    return { skipped: true };
  }
  let segments;
  try {
    segments = await transcribe(wav, opts);
  } catch (e) {
    console.log(`  (captions skipped: ${e.message})`);
    return { skipped: true };
  } finally {
    if (wav !== audioPath) { try { fs.unlinkSync(wav); } catch (e) {} }
  }
  if (!segments.length) {
    console.log("  (captions skipped: no speech detected)");
    return { skipped: true };
  }
  const srt = outVideo.replace(/\.[^./\\]+$/, "") + ".srt";
  writeSrt(segments, srt);
  let burned = false;
  if (opts.burn) {
    const ext = outVideo.slice(outVideo.lastIndexOf("."));
    const tmp = outVideo.replace(/\.[^./\\]+$/, "") + ".subbed" + ext;
    try {
      execFileSync("ffmpeg", ["-nostdin", "-y", "-i", outVideo,
        "-vf", `subtitles=${escSub(srt)}`, "-c:a", "copy", tmp], { stdio: "ignore" });
      fs.renameSync(tmp, outVideo);
      burned = true;
    } catch (e) {
      console.log(`  (caption burn-in failed, sidecar still written: ${e.message})`);
      try { fs.unlinkSync(tmp); } catch (e2) {}
    }
  }
  return { srt, burned };
}

module.exports = { writeSrt, transcribe, generateCaptions };
