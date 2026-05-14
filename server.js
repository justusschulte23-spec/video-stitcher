// server.js — stitched MP4 mit Crossfade, Color Grading, Sidechain Compress, Untertitel

import express from "express";
import { exec as execCb, execFile, spawn } from "child_process";
import fs from "fs";
import { promisify } from "util";
import path from "path";

const execp     = promisify(execCb);
const execFileP = promisify(execFile);

const app = express();
app.use(express.json({ limit: "10mb" }));

const TMP = "/tmp";

app.get("/health", (_req, res) => res.status(200).send("ok"));

// ------------------------------- Helpers ------------------------------------

async function downloadToFile(url, outPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed ${res.status}: ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(outPath, buf);
}

// Non-fatal download: returns destPath on success, null on failure
async function tryDownloadOptional(url, destPath, label) {
  if (!url) return null;
  try {
    await downloadToFile(url, destPath);
    console.log(`[${label}] downloaded`);
    return destPath;
  } catch (e) {
    console.error(`[${label}] download failed, skipping:`, e.message);
    return null;
  }
}

async function uploadToCloudinary(filePath, folder, resourceType = "image") {
  const CLOUD  = process.env.CLOUDINARY_CLOUD_NAME    || "Poweroflillith";
  const PRESET = process.env.CLOUDINARY_UPLOAD_PRESET || "poweroflillithvid";
  const { default: FormData } = await import("form-data");
  const { default: fetch }    = await import("node-fetch");
  const form = new FormData();
  form.append("file", fs.createReadStream(filePath));
  form.append("upload_preset", PRESET);
  form.append("folder", folder);
  const resp = await fetch(
    `https://api.cloudinary.com/v1_1/${CLOUD}/${resourceType}/upload`,
    { method: "POST", body: form }
  );
  const data = await resp.json();
  if (!data.secure_url) throw new Error("Cloudinary upload failed: " + JSON.stringify(data));
  return data.secure_url;
}

async function probeDurationSeconds(filePath) {
  const cmd = `ffprobe -v error -select_streams v:0 -show_entries stream=duration -of default=nk=1:nw=1 "${filePath}"`;
  const { stdout } = await execp(cmd, { maxBuffer: 8 * 1024 * 1024 });
  const s = parseFloat((stdout || "").trim());
  return Number.isFinite(s) && s > 0 ? s : 10.0;
}

// Read available system RAM from /proc/meminfo (Linux only)
function getAvailableMemoryMB() {
  try {
    const meminfo = fs.readFileSync("/proc/meminfo", "utf8");
    const match = meminfo.match(/MemAvailable:\s+(\d+)\s+kB/);
    return match ? Math.floor(parseInt(match[1], 10) / 1024) : null;
  } catch {
    return null;
  }
}

// --- Whisper API transcription -------------------------------------------

async function transcribeWithWhisper(audioPath) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");

  const ext = path.extname(audioPath).slice(1).toLowerCase() || "mp3";
  const mimeMap = {
    mp3: "audio/mpeg",
    m4a: "audio/mp4",
    wav: "audio/wav",
    ogg: "audio/ogg",
    webm: "audio/webm",
    flac: "audio/flac",
  };
  const mime = mimeMap[ext] || "audio/mpeg";

  const formData = new FormData();
  const blob = new Blob([fs.readFileSync(audioPath)], { type: mime });
  formData.append("file", blob, `audio.${ext}`);
  formData.append("model", "whisper-1");
  formData.append("response_format", "verbose_json");
  formData.append("timestamp_granularities[]", "word");

  const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData,
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Whisper API error ${resp.status}: ${errText}`);
  }

  const data = await resp.json();
  return data.words || [];
}

// --- Font management -------------------------------------------------------

const FONTS_DIR = "/tmp/fonts";

const FONT_URLS = {
  cinzel:          "https://cdn.jsdelivr.net/fontsource/fonts/cinzel@latest/latin-400-normal.ttf",
  montserrat_bold: "https://cdn.jsdelivr.net/fontsource/fonts/montserrat@latest/latin-700-normal.ttf",
};

let cinzelPath = null;
let montserratBoldPath = null;

async function ensureFonts() {
  if (!fs.existsSync(FONTS_DIR)) fs.mkdirSync(FONTS_DIR, { recursive: true });

  async function downloadFont(url, filename) {
    const dest = path.join(FONTS_DIR, filename);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 10_000) return dest;
    try {
      await downloadToFile(url, dest);
      console.log(`[fonts] downloaded ${filename} (${fs.statSync(dest).size} bytes)`);
      return dest;
    } catch (e) {
      console.error(`[fonts] failed to download ${filename}:`, e.message);
      return null;
    }
  }

  [cinzelPath, montserratBoldPath] = await Promise.all([
    downloadFont(FONT_URLS.cinzel, "Cinzel-Regular.ttf"),
    downloadFont(FONT_URLS.montserrat_bold, "Montserrat-Bold.ttf"),
  ]);

  console.log(`[fonts] Cinzel: ${cinzelPath}, Montserrat-Bold: ${montserratBoldPath}`);
}

function getFontForKategorie(kategorie) {
  const k = (kategorie || "").toLowerCase();
  const isLuxury = /spiritual|schmuck|jewel|gold|luxury|luxus|edelstein|kristall|feng|chakra|meditation|yoga/.test(k);
  return {
    name: isLuxury ? "Cinzel" : "Montserrat",
    isLuxury,
  };
}

// --- ASS subtitle builder (word-by-word via Whisper timestamps) -------------

const CTA_WORDS = new Set([
  "jetzt","now","kaufen","buy","bestellen","order","gratis","free","neu","new",
  "heute","today","sichern","save","holen","get","testen","try","entdecken",
  "discover","klick","click","link","bio","swipe","shop","code","deal","exklusiv",
]);

function isGoldWord(raw) {
  const w = raw.toLowerCase().replace(/[^\w€$%]/g, "");
  if (CTA_WORDS.has(w)) return true;
  if (/^[€$]?\d+([.,]\d+)?[€$%]?$/.test(w)) return true;
  return false;
}

function toASSTime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const cs = Math.round((sec - Math.floor(sec)) * 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

function buildASSFromWords(words, { isLuxury = false, fontName = "Montserrat", keyWords = [] } = {}) {
  const goldSet = new Set((keyWords || []).map((w) => w.toLowerCase()));

  const luxuryPrimary = "&H00A3D5E8";
  const luxuryShadow  = "&H004CA8C9";
  const cleanPrimary  = "&H00FFFFFF";
  const cleanBorder   = "&H4D000000";
  const goldPrimary   = "&H0037AFD4";

  const pc      = isLuxury ? luxuryPrimary : cleanPrimary;
  const oc      = isLuxury ? luxuryShadow  : cleanBorder;
  const bold    = isLuxury ? 0 : 1;
  const outline = isLuxury ? 2 : 1;

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 1
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Hook,${fontName},72,${pc},&H000000FF,${oc},&H00000000,${bold},0,0,0,0,100,100,0,0,1,${outline},0,2,10,10,80,1
Style: Normal,${fontName},58,${pc},&H000000FF,${oc},&H00000000,${bold},0,0,0,0,100,100,0,0,1,${outline},0,2,10,10,80,1
Style: Gold,${fontName},58,${goldPrimary},&H000000FF,${oc},&H00000000,${bold},0,0,0,0,100,100,0,0,1,${outline},0,2,10,10,80,1
Style: GoldHook,${fontName},72,${goldPrimary},&H000000FF,${oc},&H00000000,${bold},0,0,0,0,100,100,0,0,1,${outline},0,2,10,10,80,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  if (!words.length) return header;

  const lines = [];
  words.forEach((w, idx) => {
    const text = (w.word || "").replace(/[{}]/g, "").trim();
    if (!text) return;

    const start    = w.start ?? 0;
    const end      = w.end   ?? (start + 0.5);
    const nextStart = words[idx + 1]?.start ?? (end + 1.5);
    const dispEnd  = Math.min(nextStart - 0.02, end + 2.0);
    const safeEnd  = Math.max(start + 0.15, dispEnd);

    const isHook = idx < 3;
    const isGold = goldSet.has(text.toLowerCase()) || isGoldWord(text);

    let style;
    if (isHook && isGold)  style = "GoldHook";
    else if (isHook)       style = "Hook";
    else if (isGold)       style = "Gold";
    else                   style = "Normal";

    lines.push(
      `Dialogue: 0,${toASSTime(start)},${toASSTime(safeEnd)},${style},,0,0,0,,{\\fad(100,0)}${text}`
    );
  });

  return header + lines.join("\n") + "\n";
}

async function buildWordASSFromText(text, timingFile, fontOpts = {}) {
  const probeCmd = `ffprobe -v error -show_entries format=duration -of default=nk=1:nw=1 "${timingFile}"`;
  const { stdout } = await execp(probeCmd, { maxBuffer: 8 * 1024 * 1024 });

  const rawTotal = Math.max(0.1, parseFloat((stdout || "0").trim()) || 0);
  const total    = rawTotal * 1.08;

  const allWords = (text || "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (!allWords.length) return buildASSFromWords([], fontOpts);

  let per = total / allWords.length;
  per = Math.max(0.25, Math.min(1.2, per));

  const wordObjs = allWords.map((w, idx) => ({
    word:  w,
    start: idx * per,
    end:   Math.min(total, (idx + 1) * per),
  }));

  return buildASSFromWords(wordObjs, fontOpts);
}

function escPathForFilter(p) {
  return p.replace(/\\/g, "\\\\").replace(/:/g, "\\:");
}

function getColorGradeFilter(kategorie) {
  const k = (kategorie || "").toLowerCase();
  if (/spiritual|schmuck|jewel|gold/.test(k))
    return ",colorbalance=rs=0.1:gs=0.05:bs=-0.1";
  if (/supplement|fitness|sport|protein/.test(k))
    return ",colorbalance=rs=-0.05:gs=0.05:bs=0.1";
  if (/skincare|beauty|kosmetik|skin|pflege/.test(k))
    return ",colorbalance=rs=0.05:gs=0.02:bs=-0.05";
  return "";
}

// ------------------------------- /composite ---------------------------------

app.post("/composite", async (req, res) => {
  const {
    background_url,
    product_url,
    scale    = 0.55,
    position = "center",
  } = req.body || {};

  if (!background_url || !product_url)
    return res.status(400).json({ error: "background_url and product_url required" });

  const jobId      = Date.now().toString();
  const bgPath     = path.join(TMP, `comp_bg_${jobId}.jpg`);
  const productPath = path.join(TMP, `comp_prod_${jobId}.png`);
  const outPath    = path.join(TMP, `comp_out_${jobId}.jpg`);

  try {
    await Promise.all([
      downloadToFile(background_url, bgPath),
      downloadToFile(product_url, productPath),
    ]);

    const { stdout } = await execFileP(
      "python3",
      ["composite.py", bgPath, productPath, outPath, String(scale), position],
      { timeout: 60000, maxBuffer: 10 * 1024 * 1024 }
    );

    const parts = stdout.trim().split(",");
    const w = parseInt(parts[0], 10);
    const h = parseInt(parts[1], 10);

    const compositedUrl = await uploadToCloudinary(outPath, "composited_frames", "image");
    res.json({ composited_url: compositedUrl, width: w, height: h });
  } catch (err) {
    console.error("[composite] Error:", err.message.slice(0, 300));
    if (!res.headersSent) res.status(500).json({ error: "composite_failed", detail: String(err) });
  } finally {
    for (const p of [bgPath, productPath, outPath]) {
      try { fs.unlinkSync(p); } catch {}
    }
  }
});

// ------------------------------- /stitch ------------------------------------

app.post("/stitch", async (req, res) => {
  res.setTimeout(600000);

  const availMB = getAvailableMemoryMB();
  console.log(`[memory] available: ${availMB ?? "unknown"}MB`);
  if (availMB !== null && availMB < 200) {
    return res.status(503).json({
      error: "insufficient_memory",
      available_mb: availMB,
      message: "Server RAM too low — retry in a moment",
    });
  }

  try {
    const clips = req.body?.clips;
    const fade = Number(req.body?.fade ?? 0.5);
    const {
      audioUrl,
      audioGain = 1.0,
      backgroundMusicUrl,
      backgroundMusicGain = 0.25,
      targetDuration = 29,
      fadeOut = 2,
      autoSubtitles = true,
      shop_kategorie,
      key_words = [],
    } = req.body || {};

    const subtitlesText  = req.body?.subtitles_text || "";

    if (!Array.isArray(clips) || clips.length < 2) {
      return res.status(400).json({ error: "Provide clips: [url1,url2,url3]" });
    }

    const fontInfo = getFontForKategorie(shop_kategorie);

    const clipCount_dl = Math.min(3, clips.length);
    const clipPaths = Array.from({ length: clipCount_dl }, (_, i) => path.join(TMP, `clip_${i}.mp4`));
    const audioCand = audioUrl
      ? path.join(TMP, `voiceover${path.extname(new URL(audioUrl).pathname) || ".mp3"}`)
      : null;
    const bgmCand = backgroundMusicUrl
      ? path.join(TMP, `bgm${path.extname(new URL(backgroundMusicUrl).pathname) || ".mp3"}`)
      : null;

    console.log(`[download] fetching ${clipCount_dl} clip(s) + audio/bgm in parallel...`);
    const dlStart = Date.now();

    const [local, audioPath, bgmPath] = await Promise.all([
      Promise.all(
        clips.slice(0, 3).map((url, i) => downloadToFile(url, clipPaths[i]).then(() => clipPaths[i]))
      ),
      audioUrl
        ? downloadToFile(audioUrl, audioCand).then(() => audioCand)
        : Promise.resolve(null),
      tryDownloadOptional(backgroundMusicUrl, bgmCand, "bgm"),
    ]);

    console.log(`[download] all assets ready in ${((Date.now() - dlStart) / 1000).toFixed(1)}s`);

    let voIdx = -1, bgmIdx = -1;
    const ffInputArgs = [...local.flatMap((p) => ["-i", p])];
    if (audioPath) {
      voIdx = local.length;
      ffInputArgs.push("-i", audioPath);
    }
    if (bgmPath) {
      bgmIdx = local.length + (audioPath ? 1 : 0);
      ffInputArgs.push("-i", bgmPath);
    }

    const durations = await Promise.all(local.map(probeDurationSeconds));

    const d0 = durations[0] ?? 10.0;
    const d1 = durations[1] ?? 10.0;
    const clipCount = local.length;
    const sumDur = durations.reduce((a, b) => a + (b || 0), 0);
    const estTotal = Math.max(0, sumDur - (clipCount - 1) * fade);
    const padNeeded = Math.max(0, Number(targetDuration) - estTotal);
    const fadeStart = Math.max(0, Number(targetDuration) - Number(fadeOut));

    const videoFilter =
      `[0:v]setpts=PTS-STARTPTS[v0];` +
      `[1:v]setpts=PTS-STARTPTS[v1];` +
      (local[2] ? `[2:v]setpts=PTS-STARTPTS[v2];` : "") +
      `[v0][v1]xfade=transition=fade:duration=${fade}:offset=${Math.max(0, d0 - fade).toFixed(3)}[v01];` +
      (local[2]
        ? `[v01][v2]xfade=transition=fade:duration=${fade}:offset=${Math.max(0, d0 + d1 - 2 * fade).toFixed(3)}[vout]`
        : `[v01]copy[vout]`);

    const out = path.join(TMP, "stitched.mp4");

    const SUBDIR = "/tmp/subs";
    if (!fs.existsSync(SUBDIR)) fs.mkdirSync(SUBDIR, { recursive: true });
    const subtitleFile = path.join(SUBDIR, "subtitles.ass");
    let haveSubtitleFile = false;

    const assOpts = { isLuxury: fontInfo.isLuxury, fontName: fontInfo.name, keyWords: key_words };

    if (subtitlesText) {
      const cleanedText = subtitlesText
        .replace(/^﻿/, "")
        .replace(/\r\n/g, "\n")
        .replace(/^\d+\s*$/gm, "")
        .replace(/^\d{2}:\d{2}:\d{2}[,.]\d{3}\s+-->\s+\d{2}:\d{2}:\d{2}[,.]\d{3}.*$/gm, "")
        .replace(/^\s*$/gm, "")
        .trim();
      if (cleanedText) {
        const baseForTiming = audioPath || local[0];
        const assContent = await buildWordASSFromText(cleanedText, baseForTiming, assOpts);
        fs.writeFileSync(subtitleFile, assContent, "utf8");
        await new Promise((r) => setTimeout(r, 150));
        haveSubtitleFile = fs.existsSync(subtitleFile);
      }
    } else if (audioPath && autoSubtitles && process.env.OPENAI_API_KEY) {
      try {
        console.log("[whisper] transcribing audio...");
        const words = await transcribeWithWhisper(audioPath);
        const assContent = buildASSFromWords(words, assOpts);
        fs.writeFileSync(subtitleFile, assContent, "utf8");
        await new Promise((r) => setTimeout(r, 150));
        haveSubtitleFile = fs.existsSync(subtitleFile);
        console.log(`[whisper] ${words.length} words → ASS written (font: ${fontInfo.name}, luxury: ${fontInfo.isLuxury})`);
      } catch (e) {
        console.error("[whisper] transcription failed, skipping subtitles:", e.message);
      }
    }

    const subFilter = haveSubtitleFile
      ? `,subtitles=${escPathForFilter(subtitleFile)}:fontsdir=${escPathForFilter(FONTS_DIR)}`
      : "";
    const colorGrade = getColorGradeFilter(shop_kategorie);

    const videoPostProcess =
      `[vout]scale=-2:720${colorGrade}${subFilter}` +
      (padNeeded > 0 ? `,tpad=stop_mode=clone:stop_duration=${padNeeded.toFixed(3)}` : "") +
      `,fade=t=out:st=${fadeStart.toFixed(3)}:d=${Number(fadeOut).toFixed(3)}[vpre]`;

    let audioFilterStr = "";
    let audioMapTarget = "";

    if (audioPath && bgmPath) {
      audioFilterStr =
        `;[${voIdx}:a]asplit=2[vo_raw][vo_sc]` +
        `;[vo_raw]volume=${Number(audioGain).toFixed(4)}[vo_mix]` +
        `;[${bgmIdx}:a]volume=${Number(backgroundMusicGain).toFixed(4)}[bgm_base]` +
        `;[bgm_base][vo_sc]sidechaincompress=threshold=0.02:ratio=6:attack=10:release=250:level_sc=0.9[bgm_duck]` +
        `;[bgm_duck][vo_mix]amix=inputs=2:duration=longest:dropout_transition=2[aout]`;
      audioMapTarget = "[aout]";
    } else if (audioPath) {
      audioFilterStr = `;[${voIdx}:a]aresample=48000,volume=${Number(audioGain).toFixed(4)}[aout]`;
      audioMapTarget = "[aout]";
    } else if (bgmPath) {
      audioFilterStr = `;[${bgmIdx}:a]volume=${Number(backgroundMusicGain).toFixed(4)}[aout]`;
      audioMapTarget = "[aout]";
    }

    const fullFilter =
      `${videoFilter};${videoPostProcess}` +
      `;[vpre]format=yuv420p[v]` +
      `${audioFilterStr}`;

    const args = [
      "-y", "-nostdin", "-loglevel", "error",
      ...ffInputArgs,
      "-filter_complex", fullFilter,
      "-map", "[v]",
      ...(audioMapTarget ? ["-map", audioMapTarget, "-c:a", "aac", "-b:a", "192k"] : ["-an"]),
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28",
      "-profile:v", "high", "-level", "4.0",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      "-shortest",
      out,
    ];

    const ff = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });

    let ffErr = "";
    ff.stderr.on("data", (d) => {
      const s = d.toString();
      ffErr += s;
      process.stderr.write(`[ffmpeg] ${s}`);
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
        if (bgmPath && fs.existsSync(bgmPath)) fs.unlinkSync(bgmPath);
        if (fs.existsSync(subtitleFile)) fs.unlinkSync(subtitleFile);
        if (fs.existsSync(out)) fs.unlinkSync(out);
      } catch {}
    });
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: "stitch_failed", detail: String(err) });
  }
});

// ------------------------------ Server start ---------------------------------

const port = process.env.PORT || 3000;
const server = app.listen(port, () => console.log(`Server running on port ${port}`));
server.requestTimeout = 600000;
server.headersTimeout = 610000;
if (typeof server.setTimeout === "function") server.setTimeout(600000);

ensureFonts().catch((e) => console.error("[fonts] startup download error:", e.message));
