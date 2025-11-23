// server.js — stitched MP4 mit Crossfade, Untertitel & faststart

import express from "express";
import { exec as execCb, spawn } from "child_process";
import fs from "fs";
import { promisify } from "util";
import path from "path";

const execp = promisify(execCb);

const app = express();
app.use(express.json({ limit: "10mb" })); // etwas großzügiger

// ------------------------------ Basics ---------------------------------------

const TMP = "/tmp"; // Schreibbar auf Railway

// Healthcheck für Railway
app.get("/health", (_req, res) => res.status(200).send("ok"));

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

// --- Untertitel-Generator -----------------------------------------------
// wir strecken minimal (~8%), damit die Untertitel ruhiger laufen
async function buildWordSRTFromText(text, timingFile) {
  const probeCmd = `ffprobe -v error -show_entries format=duration -of default=nk=1:nw=1 "${timingFile}"`;
  const { stdout } = await execp(probeCmd, { maxBuffer: 8 * 1024 * 1024 });

  const rawTotal = Math.max(0.1, parseFloat((stdout || "0").trim()) || 0);

  const stretchFactor = 1.08; // <<< geändert – Untertitel etwas langsamer
  const total = rawTotal * stretchFactor;

  const words = (text || "")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);

  if (!words.length) return "1\n00:00:00,000 --> 00:00:00,600\n \n";

  let per = total / words.length;
  per = Math.max(0.25, Math.min(1.2, per));

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

function escPathForFilter(p) {
  return p.replace(/\\/g, "\\\\").replace(/:/g, "\\:");
}

// ------------------------------- Route --------------------------------------

app.post("/stitch", async (req, res) => {
  res.setTimeout(600000);

  try {
    const clips = req.body?.clips;
    const fade = Number(req.body?.fade ?? 0.5);

    // <<< geändert – neue Defaults
   const {
  audioUrl,
  audioGain = 1.0,
  subtitleDelay = 0.1,
  targetDuration = 29, // 3 x 9s Clips ≈ 27s + 1s Puffer
  fadeOut = 2          // 1s Fade-Out am Ende
} = req.body || {};


    const subtitlesText = req.body?.subtitles_text || "";

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

    // 2) Audio laden
    let audioPath = null;
    if (audioUrl) {
      const ext = path.extname(new URL(audioUrl).pathname) || ".mp3";
      audioPath = path.join(TMP, `voiceover${ext}`);
      await downloadToFile(audioUrl, audioPath);
    }

    // 3) Clip-Längen
    const durations = [];
    for (const p of local) durations.push(await probeDurationSeconds(p));

    const d0 = durations[0] ?? 10.0;
    const d1 = durations[1] ?? 10.0;

    const clipCount = local.length;
    const sumDur = durations.reduce((a, b) => a + (b || 0), 0);
    const estTotal = Math.max(0, sumDur - (clipCount - 1) * fade);

    const padNeeded = Math.max(0, Number(targetDuration) - estTotal);
    const fadeStart = Math.max(0, Number(targetDuration) - Number(fadeOut));

    // 4) Filtergraph
    const filter =
      `[0:v]setpts=PTS-STARTPTS[v0];` +
      `[1:v]setpts=PTS-STARTPTS[v1];` +
      (local[2] ? `[2:v]setpts=PTS-STARTPTS[v2];` : "") +
      `[v0][v1]xfade=transition=fade:duration=${fade}:offset=${Math.max(0, d0 - fade).toFixed(3)}[v01];` +
      (local[2]
        ? `[v01][v2]xfade=transition=fade:duration=${fade}:offset=${Math.max(0, d0 + d1 - 2 * fade).toFixed(3)}[vout]`
        : `[v01]copy[vout]`);

    const out = path.join(TMP, "stitched.mp4");

    // 5) Untertitel
    const SUBDIR = "/tmp/subs";
    if (!fs.existsSync(SUBDIR)) fs.mkdirSync(SUBDIR, { recursive: true });

    const subtitleFile = path.join(SUBDIR, "subtitles.srt");
    let haveSubtitleFile = false;

    const cleanedText = (subtitlesText || "")
      .replace(/^\uFEFF/, "")
      .replace(/\r\n/g, "\n")
      .replace(/^\d+\s*$/gm, "")
      .replace(/^\d{2}:\d{2}:\d{2}[,\.]\d{3}\s+-->\s+\d{2}:\d{2}:\d{2}[,\.]\d{3}.*$/gm, "")
      .replace(/^\s*$/gm, "")
      .trim();

    if (cleanedText) {
      const baseForTiming = audioPath || local[0];
      const wordSrt = await buildWordSRTFromText(cleanedText, baseForTiming);
      fs.writeFileSync(subtitleFile, wordSrt, "utf8");
      await new Promise((r) => setTimeout(r, 150));
      haveSubtitleFile = fs.existsSync(subtitleFile);
    }

   const forceStyle =
  "Fontname=Anton," +
  "Fontsize=36," +
  "PrimaryColour=&H00FFFFFF&," +                 // Weiße Schrift
  "OutlineColour=&HAA74D514&," +                 // Goldener Rand (mit 66% Deckkraft)
  "BorderStyle=1," +                             // Nur Outline
  "Outline=0.5," +                               // Haarbreit (super dünn)
  "Shadow=0," +
  "Alignment=2," +                               // Zentriert unten
  "MarginV=64";                                  // Abstand zum Rand



    const subFilter = haveSubtitleFile
      ? `,subtitles=${escPathForFilter(subtitleFile)}:si=${Number(subtitleDelay).toFixed(2)}:force_style='${forceStyle}':fontsdir=/app/fonts`
      : "";

    // 7) FFmpeg args
    const args = [
      "-y", "-nostdin", "-loglevel", "error",
      ...local.flatMap((p) => ["-i", p]),
      ...(audioPath ? ["-i", audioPath] : []),
      "-filter_complex",
      `${filter};[vout]scale=1080:-2,fps=30,format=yuv420p${subFilter}` +
      (padNeeded > 0 ? `,tpad=stop_mode=clone:stop_duration=${padNeeded.toFixed(3)}` : "") +
      `,fade=t=out:st=${fadeStart.toFixed(3)}:d=${Number(fadeOut).toFixed(3)}[v]`,
            // Mapping
      "-map", "[v]",
      ...(audioPath
        ? [
            "-map",
            `${local.length}:a?`,
            "-filter:a",
            `aresample=48000,volume=${audioGain}`,
            "-c:a",
            "aac",
            "-b:a",
            "192k",
          ]
        : ["-an"]),
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
      "-profile:v", "high", "-level", "4.0",
      "-movflags", "+faststart",
      "-shortest",
      out
    ];

    const ff = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });

    let ffErr = "";
    ff.stderr.on("data", (d) => {
      const s = d.toString(); ffErr += s; process.stderr.write(`[ffmpeg] ${s}`);
    });

    ff.on("close", async (code) => {
      if (code !== 0) {
        if (!res.headersSent) res.status(500).json({ error: "FFmpeg failed", details: ffErr });
        return;
      }
      try {
        const stat = fs.statSync(out);
        res.setHeader("Content-Type", "video/mp4");
        res.setHeader("Content-Length", stat.size);
        res.setHeader("Content-Disposition", 'attachment; filename="stitched.mp4"');
        fs.createReadStream(out).pipe(res);
      } catch (e) {
        if (!res.headersSent) res.status(500).json({ error: "send_failed", details: String(e) });
      }
    });

    res.on("close", () => {
      try {
        for (const p of local) if (fs.existsSync(p)) fs.unlinkSync(p);
        if (audioPath && fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
        if (fs.existsSync(subtitleFile)) fs.unlinkSync(subtitleFile);
        if (fs.existsSync(out)) fs.unlinkSync(out);
      } catch { }
    });

  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: "stitch_failed", detail: String(err) });
  }
});

// ------------------------------ Server start ---------------------------------

const port = process.env.PORT || 3000;
const server = app.listen(port, () =>
  console.log(`Server running on port ${port}`)
);
server.requestTimeout = 600000;
server.headersTimeout = 610000;
if (typeof server.setTimeout === "function") server.setTimeout(600000);
