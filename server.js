// server.js  — Drop-in Version: stitched MP4 mit Crossfade & faststart

import express from "express";
import { exec } from "child_process";
import fs from "fs";
import { promisify } from "util";
import path from "path";

const app = express();
app.use(express.json({ limit: "5mb" }));

const execa = promisify(exec);
const TMP = "/tmp";

// kleine Helper
async function downloadToFile(url, outPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed ${res.status}: ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(outPath, buf);
}

async function probeDurationSeconds(filePath) {
  // ffprobe liefert Dauer in Sekunden (float) – falls leer, fallback 10.0
  const cmd = `ffprobe -v error -select_streams v:0 -show_entries stream=duration -of default=nk=1:nw=1 "${filePath}"`;
  const { stdout } = await execa(cmd);
  const s = parseFloat((stdout || "").trim());
  return Number.isFinite(s) && s > 0 ? s : 10.0;
}

app.get("/healthz", (_req, res) => res.send("ok"));

app.post("/stitch", async (req, res) => {
  try {
    const clips = req.body?.clips;
    const fade = Number(req.body?.fade ?? 0.5); // Sekunden
    const { audioUrl, audioGain = 1.0 } = req.body || {};
   const subtitlesText = req.body?.subtitles_text || null;

    if (!Array.isArray(clips) || clips.length < 2) {
      return res.status(400).json({ error: "Provide clips: [url1,url2,url3]" });
    }

    // 1) Downloads
    const local = [];
    for (let i = 0; i < clips.length; i++) {
      const p = path.join(TMP, `clip_${i}.mp4`);
      await downloadToFile(clips[i], p);
      local.push(p);
    }
let audioPath = null;
if (audioUrl) {
  audioPath = path.join(TMP, "voiceover.mp3");
  await downloadToFile(audioUrl, audioPath);
}

    // 2) Dauer pro Clip (für xfade-Offsets)
    const durations = [];
    for (const p of local) durations.push(await probeDurationSeconds(p));
    // mind. zwei Werte vorhanden
    const d0 = durations[0];
    const d1 = durations[1];

    // 3) Filter-Graph: Crossfades hintereinander
    // v0 -> v1 (offset d0 - fade), Ergebnis v01
    // v01 -> v2 (offset d0 + d1 - 2*fade), Ergebnis vout
// Inputs für ffmpeg (Videos + optional Audio)
let inputs = local.map(p => `-i "${p}"`).join(" ");
if (audioPath) inputs += ` -i "${audioPath}"`; // macht Audio zum 4. Input (Index 3)


    const filter =
      `[0:v]setpts=PTS-STARTPTS[v0];` +
      `[1:v]setpts=PTS-STARTPTS[v1];` +
      `[2:v]setpts=PTS-STARTPTS[v2];` +
      `[v0][v1]xfade=transition=fade:duration=${fade}:offset=${Math.max(
        0,
        d0 - fade
      ).toFixed(3)}[v01];` +
      `[v01][v2]xfade=transition=fade:duration=${fade}:offset=${Math.max(
        0,
        d0 + d1 - 2 * fade
      ).toFixed(3)}[vout]`;

    const out = path.join(TMP, "stitched.mp4");
// 4) Subtitle-Datei vorbereiten (falls Text mitgeliefert wurde)
const subtitleFile = path.join(TMP, "subtitles.srt");
if (subtitlesText) fs.writeFileSync(subtitleFile, subtitlesText, "utf8");

// 5) FFmpeg-Teil für Untertitel (nur wenn vorhanden)
// subFilter ist ein Filter-Schnipsel, der in die Video-Kette eingefügt wird
const subFilter = subtitlesText
  ? `,subtitles='${subtitleFile.replace(/\\/g,"/")}':force_style=Fontname=Anton,Fontsize=36,PrimaryColour=&H00FFFFFF&,OutlineColour=&H000000&,BorderStyle=3,Outline=2,Shadow=1`
  : "";

    
// 6) FFmpeg = Videos + optional Audio + Untertitel kombinieren
const cmd = `
ffmpeg -y -nostdin -loglevel error ${inputs} \
 -filter_complex "${filter};[vout]scale=1080:-2,fps=30,format=yuv420p${subFilter}[v]" \
 -map "[v]" \
 ${audioPath
    ? `-map 3:a -filter:a "aresample=48000,volume=${audioGain}" -c:a aac -b:a 192k`
    : `-an`} \
 -c:v libx264 -profile:v high -level 4.0 -movflags +faststart -shortest "${out}"
`.replace(/\s+/g, " ");

let result;
try {
  result = await exec(cmd);
} catch (e) {
  console.error("FFmpeg error:", e.stderr || e.message || e);
  return res.status(500).json({
    error: "FFmpeg failed",
    details: e.stderr || String(e),
  });
}

// Falls FFmpeg „grün“ zurückkam, aber keine Datei schrieb:
if (!fs.existsSync(out)) {
  console.error("Output missing. FFmpeg stderr:", result?.stderr);
  return res.status(500).json({
    error: "Output file not created",
    details: result?.stderr || "No stderr returned",
  });
}

// 5) Datei zurückgeben
const stat = fs.statSync(out);
res.setHeader("Content-Type", "video/mp4");
res.setHeader("Content-Length", stat.size);
res.setHeader("Content-Disposition", 'attachment; filename="stitched.mp4"');
fs.createReadStream(out).pipe(res);
