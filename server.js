// server.js — Drop-in Version: stitched MP4 mit Crossfade, Untertitel & faststart

import express from "express";
import { exec as execCb } from "child_process";
import fs from "fs";
import { promisify } from "util";
import path from "path";

const execp = promisify(execCb);          // promisified exec

// ---- Anton Font Registration ----
const FONTS_DIR = path.join(process.cwd(), "video-stitcher"); // Pfad anpassen, da Font im Root-Ordner liegt

try {
  if (fs.existsSync(FONTS_DIR)) {
    console.log("Registering local Anton font...");
    // Font ins System kopieren und Cache aktualisieren
    await execp(
      `mkdir -p /usr/share/fonts/truetype/custom && cp ${FONTS_DIR}/*.ttf /usr/share/fonts/truetype/custom && fc-cache -fv`
    );
    console.log("Anton font registered successfully.");
  }
} catch (e) {
  console.warn("Font registration skipped:", e.message);
}

const app = express();
app.use(express.json({ limit: "5mb" }));

const TMP = "/tmp";

// --- kleine Helper -----------------------------------------------------------
async function downloadToFile(url, outPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed ${res.status}: ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(outPath, buf);
}

async function probeDurationSeconds(filePath) {
  // ffprobe liefert Dauer der Video-Streamspur (Sekunden, float)
  const cmd = `ffprobe -v error -select_streams v:0 -show_entries stream=duration -of default=nk=1:nw=1 "${filePath}"`;
  const { stdout } = await execp(cmd, { maxBuffer: 8 * 1024 * 1024 });
  const s = parseFloat((stdout || "").trim());
  return Number.isFinite(s) && s > 0 ? s : 10.0;
}

app.get("/healthz", (_req, res) => res.send("ok"));

// --- Haupt-Route --------------------------------------------------------------
app.post("/stitch", async (req, res) => {
  // Verbindung lange offen halten (gegen 502)
  res.setTimeout(600000); // 10 Minuten

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

    // 2) Dauer pro Clip (für xfade-Offsets) – wir nutzen die ersten drei Clips
    const durations = [];
    for (const p of local.slice(0, 3)) {
      durations.push(await probeDurationSeconds(p));
    }
    const d0 = durations[0];
    const d1 = durations[1];

    // Baut eine SRT, in der jedes Wort nacheinander erscheint (gleichmäßig über die Audio-Dauer verteilt).
async function buildWordSRTFromText(text, audioPath) {
  const probeCmd = `ffprobe -v error -show_entries format=duration -of default=nk=1:nw=1 "${audioPath}"`;
  const { stdout } = await execp(probeCmd, { maxBuffer: 8 * 1024 * 1024 });
  const total = Math.max(0.1, parseFloat((stdout || "0").trim()) || 0);

  const words = (text || "")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);

  if (!words.length) return "1\n00:00:00,000 --> 00:00:00,500\n \n";

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


    

    // 3) Filter-Graph: Crossfades hintereinander (3 Clips)
    // v0 -> v1 (offset d0 - fade) = [v01]
    // v01 -> v2 (offset d0 + d1 - 2*fade) = [vout]
    let inputs = local.slice(0, 3).map(p => `-i "${p}"`).join(" ");
    if (audioPath) inputs += ` -i "${audioPath}"`; // Audio ist dann 4. Input (Index 3)

    const filter =
      `[0:v]setpts=PTS-STARTPTS[v0];` +
      `[1:v]setpts=PTS-STARTPTS[v1];` +
      `[2:v]setpts=PTS-STARTPTS[v2];` +
      `[v0][v1]xfade=transition=fade:duration=${fade}:offset=${Math.max(0, d0 - fade).toFixed(3)}[v01];` +
      `[v01][v2]xfade=transition=fade:duration=${fade}:offset=${Math.max(0, d0 + d1 - 2 * fade).toFixed(3)}[vout]`;

    const out = path.join(TMP, "stitched.mp4");

   // 4) Subtitle-Datei vorbereiten
const subtitleFile = path.join(TMP, "subtitles.srt");

// 4a) Eingehenden Text erstmal von SRT-Kram befreien
const rawSubtitleText = subtitlesText || "";
const cleanedSubtitleText = rawSubtitleText
  // Zeilen wie "00:00:00,000 --> 00:00:05,652" raus
  .replace(/^\d{2}:\d{2}:\d{2},\d{3}\s+-->\s+\d{2}:\d{2}:\d{2},\d{3}$/gm, "")
  // reine Nummernzeilen (1, 2, 3, ...)
  .replace(/^\d+\s*$/gm, "")
  // leere Zeilen auf eine reduzieren
  .replace(/\n{2,}/g, "\n")
  .trim();

if (req.body?.subtitle_mode === "words" && cleanedSubtitleText && audioPath) {
  // Wort-für-Wort-SRT aus dem gesäuberten Text bauen
  const wordSrt = await buildWordSRTFromText(cleanedSubtitleText, audioPath);
  fs.writeFileSync(subtitleFile, wordSrt, "utf8");
} else if (cleanedSubtitleText) {
  // ansonsten: (bereinigten) Text/SRT schreiben
  fs.writeFileSync(subtitleFile, cleanedSubtitleText, "utf8");
}


 // 5) Untertitel-Filter-Schnipsel (Outline, unten mittig, kein Kasten)
// Hinweis: Font "Anton" muss im Container installiert sein; sonst nimmt libass einen Fallback.
const subFilter = subtitlesText
  ? `,subtitles='${subtitleFile.replace(/\\/g, "/")}':force_style='FontName=Anton,FontSize=48,PrimaryColour=&H00FFFFFF&,OutlineColour=&H000000&,BorderStyle=1,Outline=3,Shadow=0,Alignment=2,MarginV=220'`
  : "";


    // 6) FFmpeg = Videos + optional Audio + Untertitel kombinieren
    const cmd = `
ffmpeg -y -nostdin -loglevel error ${inputs} \
 -filter_complex "${filter};[vout]scale=1080:-2,fps=30,format=yuv420p${subFilter}[v]" \
 -map "[v]" \
 ${audioPath ? `-map 3:a -filter:a "aresample=48000,volume=${audioGain}" -c:a aac -b:a 192k` : `-an`} \
 -c:v libx264 -preset ultrafast -crf 23 -profile:v high -level 4.0 -movflags +faststart -shortest "${out}"
`.replace(/\s+/g, " ");

    let result;
    try {
      result = await execp(cmd, { maxBuffer: 8 * 1024 * 1024 });
    } catch (e) {
      const errText = typeof e?.stderr === "string" ? e.stderr
        : Buffer.isBuffer(e?.stderr) ? e.stderr.toString("utf8")
        : e?.message || String(e);
      console.error("FFmpeg error:", errText);
      return res.status(500).json({ error: "FFmpeg failed", details: errText });
    }

    // 7) Falls FFmpeg „grün“ war, aber keine Datei schrieb
    if (!fs.existsSync(out)) {
      const stderrText = typeof result?.stderr === "string" ? result.stderr
        : Buffer.isBuffer(result?.stderr) ? result.stderr.toString("utf8")
        : "No stderr returned";
      console.error("Output missing. FFmpeg stderr:", stderrText);
      return res.status(500).json({ error: "Output file not created", details: stderrText });
    }

    // 8) Datei zurückgeben
    const stat = fs.statSync(out);
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Length", stat.size);
    res.setHeader("Content-Disposition", 'attachment; filename="stitched.mp4"');
    fs.createReadStream(out).pipe(res);

  } catch (err) {
    console.error("Server error:", err);
    return res.status(500).json({ error: String(err?.message || err) });
  }
}); // schließt app.post("/stitch")

// --- Server starten + Timeouts hochsetzen ------------------------------------
const port = process.env.PORT || 3000;
const server = app.listen(port, () => console.log(`Server running on port ${port}`));
server.requestTimeout = 600000;   // 10 Min
server.headersTimeout = 610000;
server.setTimeout?.(600000);
