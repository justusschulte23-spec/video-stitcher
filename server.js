// server.js — stitched MP4 mit Crossfade, Untertitel & faststart

import express from "express";
import { exec as execCb } from "child_process";
import fs from "fs";
import { promisify } from "util";
import path from "path";

const execp = promisify(execCb);

const app = express();
app.use(express.json({ limit: "5mb" }));

// Verzeichnisse
const WORKDIR = process.cwd();              // z.B. /app
const TMP = "/tmp";                         // für Videos ok

// 1) Fonts registrieren – vorerst deaktiviert, weil Railway beim Start sonst zu lange blockt
// const FONTS_DIR = path.join(WORKDIR, "fonts");
// try {
//   if (fs.existsSync(FONTS_DIR)) {
//     console.log("Registering local Anton font ...");
//     await execp(
//       `mkdir -p /usr/share/fonts/truetype/custom && cp ${FONTS_DIR}/*.ttf /usr/share/fonts/truetype/custom && fc-cache -fv`
//     );
//     console.log("Anton font registered.");
//   } else {
//     console.log("No fonts/ dir found, skipping font registration.");
//   }
// } catch (e) {
//   console.warn("Font registration skipped:", e.message);
// }



// -----------------------------------------------------------------------------
// Helper
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

// -----------------------------------------------------------------------------
// Route
app.post("/stitch", async (req, res) => {
  res.setTimeout(600000);

  try {
    const clips = req.body?.clips;
    const fade = Number(req.body?.fade ?? 0.5);
    const { audioUrl, audioGain = 1.0 } = req.body || {};
    const subtitlesText = req.body?.subtitles_text || null;
    const subtitleMode = req.body?.subtitle_mode || "normal";

    if (!Array.isArray(clips) || clips.length < 2) {
      return res.status(400).json({ error: "Provide clips: [url1,url2,...]" });
    }

    // 1) Videos laden
    const local = [];
    for (let i = 0; i < clips.length; i++) {
      const p = path.join(TMP, `clip_${i}.mp4`);
      await downloadToFile(clips[i], p);
      local.push(p);
    }

    // 2) Audio laden
    let audioPath = null;
    if (audioUrl) {
      audioPath = path.join(TMP, "voiceover.mp3");
      await downloadToFile(audioUrl, audioPath);
    }

    // 3) Längen bestimmen (nur 3 Clips)
    const durations = [];
    for (const p of local.slice(0, 3)) {
      durations.push(await probeDurationSeconds(p));
    }
    const d0 = durations[0];
    const d1 = durations[1];

    // 4) Wort-SRT-Builder (innerhalb der Route)
    async function buildWordSRTFromText(text, audioFile) {
      const probeCmd = `ffprobe -v error -show_entries format=duration -of default=nk=1:nw=1 "${audioFile}"`;
      const { stdout } = await execp(probeCmd, { maxBuffer: 8 * 1024 * 1024 });
      const total = Math.max(0.1, parseFloat((stdout || "0").trim()) || 0);

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
        idx++;
        t += per;
        if (t >= total) break;
      }
      return srt;
    }

    // 5) Filtergraph (Crossfade)
    let inputs = local.slice(0, 3).map((p) => `-i "${p}"`).join(" ");
    if (audioPath) inputs += ` -i "${audioPath}"`;

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

    // 6) Untertitel-Datei in sicheres, lesbares Verzeichnis schreiben
const SUBDIR = "/tmp/subs";
if (!fs.existsSync(SUBDIR)) {
  fs.mkdirSync(SUBDIR, { recursive: true });
}
const subtitleFile = path.join(SUBDIR, "subtitles.srt");
let haveSubtitleFile = false;


    // n8n-SRT säubern
    const cleanedSubtitleText = (subtitlesText || "")
      // timecodes
      .replace(
        /^\d{2}:\d{2}:\d{2},\d{3}\s+-->\s+\d{2}:\d{2}:\d{2},\d{3}.*$/gm,
        ""
      )
      // nummern
      .replace(/^\d+\s*$/gm, "")
      // mehrfach-leerzeilen
      .replace(/\n{2,}/g, "\n")
      .trim();

    // prüfen, ob der Text schon echte SRT-Timecodes hat
const looksLikeSrt = /^\d{1,4}\s*$/m.test(cleanedSubtitleText) ||
  /^\d{2}:\d{2}:\d{2},\d{3}\s+-->/m.test(cleanedSubtitleText);

if (looksLikeSrt) {
  // echte SRT → einfach speichern
  fs.writeFileSync(subtitleFile, cleanedSubtitleText, "utf8");
  haveSubtitleFile = true;
} else if (cleanedSubtitleText && audioPath) {
  // kein SRT → aus Fließtext Wort-SRT bauen
  const wordSrt = await buildWordSRTFromText(cleanedSubtitleText, audioPath);
  fs.writeFileSync(subtitleFile, wordSrt, "utf8");
  haveSubtitleFile = true;
} else {
  haveSubtitleFile = false;
}

  await new Promise((r) => setTimeout(r, 300));
let finalSrt = "";
if (haveSubtitleFile && fs.existsSync(subtitleFile)) {
  finalSrt = fs.readFileSync(subtitleFile, "utf8")
    .replace(/^\uFEFF/, "")         // BOM weg
    .replace(/\r\n/g, "\n")         // Windows -> Unix
    .trim();
  fs.writeFileSync(subtitleFile, finalSrt, "utf8");
  console.log("Subtitle file written:", true, subtitleFile);
  console.log("Subtitle content >>>");
  console.log(finalSrt);
} else {
  haveSubtitleFile = false;
  console.log("Subtitle file missing after write:", subtitleFile);
}


    // 7) Subtitle-Filter bauen (ohne Quotes um den Pfad!)
    const subFilter = haveSubtitleFile
      ? `,subtitles=${subtitleFile.replace(
          /\\/g,
          "/"
        )}:force_style='FontName=Anton,FontSize=56,PrimaryColour=&H00FFFFFF&,OutlineColour=&H000000&,BorderStyle=1,Outline=4,Shadow=0,Alignment=2,MarginV=300'`
      : "";

    // 8) FFmpeg-Kommando
    const cmd = `
ffmpeg -y -nostdin -loglevel error ${inputs} \
 -filter_complex "${filter};[vout]scale=1080:-2,fps=30,format=yuv420p${subFilter}[v]" \
 -map "[v]" \
 ${audioPath ? `-map 3:a -filter:a "aresample=48000,volume=${audioGain}" -c:a aac -b:a 192k` : `-an`} \
 -c:v libx264 -preset ultrafast -crf 23 -profile:v high -level 4.0 -movflags +faststart -shortest "${out}"
`.replace(/\s+/g, " ");

    let ff;
    try {
      ff = await execp(cmd, { maxBuffer: 16 * 1024 * 1024 });
    } catch (e) {
      console.error("FFmpeg error:", e.stderr || e.message || e);
      return res
        .status(500)
        .json({ error: "FFmpeg failed", details: e.stderr || String(e) });
    }

    if (!fs.existsSync(out)) {
      console.error("Output missing:", ff?.stderr);
      return res
        .status(500)
        .json({ error: "Output file not created", details: ff?.stderr || "" });
    }

    const stat = fs.statSync(out);
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Length", stat.size);
    res.setHeader("Content-Disposition", 'attachment; filename="stitched.mp4"');
    fs.createReadStream(out).pipe(res);
  } catch (err) {
    console.error("Server error:", err);
    return res.status(500).json({ error: String(err?.message || err) });
  }
});

// -----------------------------------------------------------------------------
const port = process.env.PORT || 3000;
const server = app.listen(port, () =>
  console.log(`Server running on port ${port}`)
);
server.requestTimeout = 600000;
server.headersTimeout = 610000;
server.setTimeout?.(600000);
