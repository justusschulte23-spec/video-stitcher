// server.js — stitched MP4 mit Crossfade, Untertitel & faststart

import express from "express";
import { exec as execCb } from "child_process";
import { spawn } from "child_process";
import fs from "fs";
import { promisify } from "util";
import path from "path";

const execp = promisify(execCb);

const app = express();
app.use(express.json({ limit: "5mb" }));

// Verzeichnisse
const TMP = "/tmp"; // OK für Railway

// Fonts registrieren (Anton)
const WORKDIR = process.cwd();
const FONTS_DIR = path.join(WORKDIR, "fonts");

try {
  if (fs.existsSync(FONTS_DIR)) {
    console.log("Registering local Anton font ...");
    await execp(
      `mkdir -p /usr/share/fonts/truetype/custom && cp ${FONTS_DIR}/*.ttf /usr/share/fonts/truetype/custom && fc-cache -fv`
    );
    console.log("Anton font registered.");
  } else {
    console.log("No fonts/ dir found, skipping font registration.");
  }
} catch (e) {
  console.warn("Font registration skipped:", e.message);
}

// ------------------------------- Helpers ------------------------------------

async function downloadToFile(url, outPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed ${res.status}: ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(outPath, buf);
}

async function probeDurationSeconds(filePath) {
  const cmd = `ffprobe -v error -select_streams v:0 -show_entries stream=duration -of default=nk=1:nw=1 "${filePath}"`;
  const { stdout } = await execp(cmd, { maxBuffer: 8 * 1024 * 1024 });
  const s = parseFloat((stdout || "").trim());
  return Number.isFinite(s) && s > 0 ? s : 10.0;
}

// Baut eine SRT, in der jedes Wort nacheinander erscheint (Timing aus Audio oder 1. Clip)
async function buildWordSRTFromText(text, timingFile) {
  // timingFile kann mp3 ODER mp4 sein – wir lesen die Container-Dauer
  const probeCmd = `ffprobe -v error -show_entries format=duration -of default=nk=1:nw=1 "${timingFile}"`;
  const { stdout } = await execp(probeCmd, { maxBuffer: 8 * 1024 * 1024 });
  const total = Math.max(0.1, parseFloat((stdout || "0").trim()) || 0);

  const words = (text || "")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);

  if (!words.length) return "1\n00:00:00,000 --> 00:00:00,600\n \n";

  let per = total / words.length;
  per = Math.max(0.25, Math.min(1.2, per)); // 0.25–1.2s pro Wort

  let t = 0;
  let idx = 1;
  const pad = (n) => String(n).padStart(2, "0");
  const toTC = (sec) => {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    const ms = Math.round((sec - Math.floor(sec)) * 1000);
    return `${pad(h)}:${pad(m)}:${pad(s)},${String(ms).padStart(3, "0")}`;
  };

  let srt = "";
  for (const w of words) {
    const start = toTC(t);
    const end = toTC(Math.min(total, t + per));
    srt += `${idx}\n${start} --> ${end}\n${w}\n\n`;
    idx += 1;
    t += per;
    if (t >= total) break;
  }
  if (!srt.endsWith("\n\n")) srt += "\n";
  return srt;
}

// ------------------------------- Route --------------------------------------

function escPathForFilter(p) {
  // In FFmpeg-Filter-Argumenten ':' escapen, Backslashes doppeln
  return p.replace(/\\/g, "\\\\").replace(/:/g, "\\:");
}


app.post("/stitch", async (req, res) => {
  // lange Requests erlauben (Railway 502 vermeiden)
  res.setTimeout(600000);

  try {
    const clips = req.body?.clips;
    const fade = Number(req.body?.fade ?? 0.5); // Sekunden
    const { audioUrl, audioGain = 1.0 } = req.body || {};
    const subtitlesText = req.body?.subtitles_text || ""; // kann plain Text ODER SRT sein

    if (!Array.isArray(clips) || clips.length < 2) {
      return res.status(400).json({ error: "Provide clips: [url1,url2,url3]" });
    }

    // 1) Videos laden
    const local = [];
    for (let i = 0; i < Math.min(3, clips.length); i++) {
      const p = path.join(TMP, `clip_${i}.mp4`);
      await downloadToFile(clips[i], p);
      local.push(p);
    }
    if (local.length < 2) {
      return res.status(400).json({ error: "Need at least 2 clips" });
    }

    // 2) Audio laden (optional)
    let audioPath = null;
    if (audioUrl) {
      audioPath = path.join(TMP, "voiceover.mp3");
      await downloadToFile(audioUrl, audioPath);
    }

    // 3) Clip-Längen (für Crossfade-Offsets)
    const durations = [];
    for (const p of local) durations.push(await probeDurationSeconds(p));
    const d0 = durations[0] ?? 10.0;
    const d1 = durations[1] ?? 10.0;

    // 4) Filtergraph: Crossfades
    let inputs = local.map((p) => `-i "${p}"`).join(" ");
    if (audioPath) inputs += ` -i "${audioPath}"`; // Audio wird 4. Input (Index 3)

    const filter =
      `[0:v]setpts=PTS-STARTPTS[v0];` +
      `[1:v]setpts=PTS-STARTPTS[v1];` +
      (local[2] ? `[2:v]setpts=PTS-STARTPTS[v2];` : "") +
      `[v0][v1]xfade=transition=fade:duration=${fade}:offset=${Math.max(0, d0 - fade).toFixed(3)}[v01];` +
      (local[2]
        ? `[v01][v2]xfade=transition=fade:duration=${fade}:offset=${Math.max(
            0,
            d0 + d1 - 2 * fade
          ).toFixed(3)}[vout]`
        : `[v01]copy[vout]`);

    const out = path.join(TMP, "stitched.mp4");

    // 5) Untertitel-Datei erzeugen (immer SRT bauen, sobald Text da ist)
    // --- Untertitel-Datei sicher schreiben (immer in /tmp/subs) ---
const SUBDIR = "/tmp/subs";
if (!fs.existsSync(SUBDIR)) fs.mkdirSync(SUBDIR, { recursive: true });
const subtitleFile = path.join(SUBDIR, "subtitles.srt");
let haveSubtitleFile = false;

// 1) Cleaning: SRT-Index/Timecodes raus, nur Text behalten
const cleanedText = (subtitlesText || "")
  .replace(/^\uFEFF/, "")
  .replace(/\r\n/g, "\n")
  .replace(/^\d+\s*$/gm, "")                                                        // Index-Zeilen killen
  .replace(/^\d{2}:\d{2}:\d{2}[,\.]\d{3}\s+-->\s+\d{2}:\d{2}:\d{2}[,\.]\d{3}.*$/gm, "") // Timecodes killen
  .replace(/^\s*$/gm, "")                                                           // leere Zeilen raus
  .trim();

if (cleanedText) {
  // 2) Wort-Timings auf Basis von Audio, sonst 1. Clip
  const baseForTiming = audioPath || local[0];
  const wordSrt = await buildWordSRTFromText(cleanedText, baseForTiming);

  fs.writeFileSync(subtitleFile, wordSrt, "utf8");
  await new Promise(r => setTimeout(r, 150)); // kurze Pause für FS
  haveSubtitleFile = fs.existsSync(subtitleFile);

  console.log("SRT geschrieben?", haveSubtitleFile, subtitleFile);
  if (haveSubtitleFile) {
    const preview = fs.readFileSync(subtitleFile, "utf8").split("\n").slice(0, 8).join("\n");
    console.log("SRT preview >>>\n" + preview);
  }
} else {
  console.log("Kein Subtitle-Text geliefert – skip.");
}


   // 6) Subtitle-Filter (spawn: keine Shell-Quotes nötig) – kleiner + tiefer
const subFilter = haveSubtitleFile
  ? `,subtitles=${escPathForFilter(subtitleFile)}:force_style=FontName=Anton,FontSize=36,PrimaryColour=&H00FFFFFF&,OutlineColour=&H000000&,BorderStyle=1,Outline=3,Shadow=0,Alignment=2,MarginV=64:fontsdir=/app/fonts`
  : "";



console.log("Using subtitle filter?", haveSubtitleFile, subFilter ? "(enabled)" : "(disabled)");

// 7) FFmpeg-Args bauen (spawn, kein Shell-String)
const args = [
  "-y", "-nostdin", "-loglevel", "error",

  // Inputs
  ...local.flatMap((p) => ["-i", p]),
  ...(audioPath ? ["-i", audioPath] : []),

  // Filter
  "-filter_complex",
  `${filter};[vout]scale=1080:-2,fps=30,format=yuv420p${subFilter}[v]`,

  // Mapping
  "-map", "[v]",
  ...(audioPath
    ? ["-map", `${local.length}:a?`, "-filter:a", `aresample=48000,volume=${audioGain}`, "-c:a", "aac", "-b:a", "192k"]
    : ["-an"]),

  // Video & Container
  "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
  "-profile:v", "high", "-level", "4.0",
  "-movflags", "+faststart",
  "-shortest",

  out
];

console.log("ffmpeg args >>>", JSON.stringify(args));

const ff = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });

let ffErr = "";
ff.stderr.on("data", (d) => { const s = d.toString(); ffErr += s; process.stderr.write(`[ffmpeg] ${s}`); });

ff.on("error", (e) => {
  console.error("FFmpeg spawn error:", e);
  return res.status(500).json({ error: "FFmpeg spawn error", details: String(e) });
});

ff.on("close", (code) => {
  if (code !== 0) {
    console.error("FFmpeg exited with code", code);
    if (!res.headersSent) {
      return res.status(500).json({ error: "FFmpeg failed", details: ffErr || `exit ${code}` });
    }
  }
});

// Output streamen (kein Zwischen-File nötig, aber wir behalten deine Datei-Variante bei)
// Wenn du lieber Datei streamen willst, dann statt 'out' als Ziel 'pipe:1' verwenden.
ff.on("spawn", () => {
  // Wir haben oben 'out' als Dateipfad gewählt – falls du lieber streamen willst:
  // -> args letzte Position auf 'pipe:1' ändern und hier ff.stdout.pipe(res)
  // Aktuell: Wir warten auf Prozessende und senden dann die Datei (wie bisher).
});

// Warten bis FFmpeg fertig ist, dann Datei senden
ff.on("close", async (code) => {
  if (code !== 0) return; // bereits behandelt
  try {
    if (!fs.existsSync(out)) {
      console.error("Output missing after ffmpeg");
      if (!res.headersSent) return res.status(500).json({ error: "Output file not created" });
      return;
    }
    const stat = fs.statSync(out);
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Length", stat.size);
    res.setHeader("Content-Disposition", 'attachment; filename="stitched.mp4"');
    fs.createReadStream(out).pipe(res);
  } catch (e) {
    console.error("Send output failed:", e);
    if (!res.headersSent) res.status(500).json({ error: "send_failed", details: String(e) });
  }
});

// 8) Datei zurückgeben
const stat = fs.statSync(out);
res.setHeader("Content-Type", "video/mp4");
res.setHeader("Content-Length", stat.size);
res.setHeader("Content-Disposition", 'attachment; filename="stitched.mp4"');
fs.createReadStream(out).pipe(res);


// ------------------------------ Server start ---------------------------------

const port = process.env.PORT || 3000;
const server = app.listen(port, () =>
  console.log(`Server running on port ${port}`)
);
server.requestTimeout = 600000;  // 10 Min
server.headersTimeout = 610000;
server.setTimeout?.(600000);
