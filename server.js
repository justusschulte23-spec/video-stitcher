// server.js — stitched MP4 mit Crossfade, Color Grading, Logo/Preis Overlay, Sidechain Compress, Untertitel

import express from "express";
import { exec as execCb, spawn } from "child_process";
import fs from "fs";
import { promisify } from "util";
import path from "path";

const execp = promisify(execCb);

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

async function probeDurationSeconds(filePath) {
  const cmd = `ffprobe -v error -select_streams v:0 -show_entries stream=duration -of default=nk=1:nw=1 "${filePath}"`;
  const { stdout } = await execp(cmd, { maxBuffer: 8 * 1024 * 1024 });
  const s = parseFloat((stdout || "").trim());
  return Number.isFinite(s) && s > 0 ? s : 10.0;
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

// --- SRT builder with max-words grouping + hook single-word ----------------

function buildSRTFromWords(words, { maxWordsPerLine = 1, hookSingleWord = false, hookDuration = 2.5 } = {}) {
  if (!words.length) return "1\n00:00:00,000 --> 00:00:00,600\n \n";

  const pad = (n) => String(n).padStart(2, "0");
  const toTC = (sec) => {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    const ms = Math.round((sec - Math.floor(sec)) * 1000);
    return `${pad(h)}:${pad(m)}:${pad(s)},${String(ms).padStart(3, "0")}`;
  };

  const chunks = [];
  let i = 0;
  while (i < words.length) {
    const isHook = hookSingleWord && words[i].start < hookDuration;
    const size = isHook ? 1 : Math.max(1, maxWordsPerLine);
    const slice = words.slice(i, i + size);
    const text = slice.map((w) => (w.word || "").trim()).join(" ").trim();
    if (text) chunks.push({ text, start: slice[0].start, end: slice[slice.length - 1].end });
    i += size;
  }

  let srt = "";
  chunks.forEach((c, idx) => {
    srt += `${idx + 1}\n${toTC(c.start)} --> ${toTC(c.end)}\n${c.text}\n\n`;
  });
  return srt || "1\n00:00:00,000 --> 00:00:00,600\n \n";
}

// --- Manual word-distribution SRT (fallback when no Whisper) ----------------

async function buildWordSRTFromText(text, timingFile, { maxWordsPerLine = 1, hookSingleWord = false, hookDuration = 2.5 } = {}) {
  const probeCmd = `ffprobe -v error -show_entries format=duration -of default=nk=1:nw=1 "${timingFile}"`;
  const { stdout } = await execp(probeCmd, { maxBuffer: 8 * 1024 * 1024 });

  const rawTotal = Math.max(0.1, parseFloat((stdout || "0").trim()) || 0);
  const total = rawTotal * 1.08;

  const allWords = (text || "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (!allWords.length) return "1\n00:00:00,000 --> 00:00:00,600\n \n";

  let per = total / allWords.length;
  per = Math.max(0.25, Math.min(1.2, per));

  const wordObjs = allWords.map((w, idx) => ({
    word: w,
    start: idx * per,
    end: Math.min(total, (idx + 1) * per),
  }));

  return buildSRTFromWords(wordObjs, { maxWordsPerLine, hookSingleWord, hookDuration });
}

function escPathForFilter(p) {
  return p.replace(/\\/g, "\\\\").replace(/:/g, "\\:");
}

function escDrawtext(s) {
  return String(s)
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/:/g, "\\:");
}

// --- Dynamic subtitle style builder ----------------------------------------

function buildForceStyle(subtitleStyle = {}) {
  const rawFont = subtitleStyle.font || "Anton";
  const isBold = /bold/i.test(rawFont);
  const fontFamily = rawFont.replace(/[-\s]?bold/gi, "").replace(/-/g, " ").trim() || "Anton";

  const color = subtitleStyle.color === "white" ? "&H00FFFFFF" : "&H00FFFFFF";
  const isGlow = subtitleStyle.effect === "glow";
  const outlineColor = isGlow ? "&H00000000" : "&H0037AFD4";
  const outline = isGlow ? 4 : 1;

  return [
    `Fontname=${fontFamily}`,
    "Fontsize=36",
    `PrimaryColour=${color}`,
    `OutlineColour=${outlineColor}`,
    "BorderStyle=1",
    `Outline=${outline}`,
    "Shadow=0",
    `Bold=${isBold ? 1 : 0}`,
    "Alignment=2",
    "MarginV=48",
  ].join(",");
}

// --- Color grading per shop category ---------------------------------------

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

// ------------------------------- Route --------------------------------------

app.post("/stitch", async (req, res) => {
  res.setTimeout(600000);

  try {
    const clips = req.body?.clips;
    const fade = Number(req.body?.fade ?? 0.5);
    const {
      audioUrl,
      audioGain = 1.0,
      backgroundMusicUrl,
      backgroundMusicGain = 0.25,
      subtitleDelay = 0.1,
      targetDuration = 29,
      fadeOut = 2,
      autoSubtitles = true,
      shop_kategorie,
      logo_url,
    } = req.body || {};

    const price = req.body?.price != null ? String(req.body.price) : null;
    const subtitlesText = req.body?.subtitles_text || "";
    const subtitleStyle = req.body?.subtitle_style || {};
    const maxWordsPerLine = Number(subtitleStyle.max_words_per_line || 1);
    const hookSingleWord = Boolean(subtitleStyle.hook_single_word);
    const subOpts = { maxWordsPerLine, hookSingleWord };

    if (!Array.isArray(clips) || clips.length < 2) {
      return res.status(400).json({ error: "Provide clips: [url1,url2,url3]" });
    }

    // 1-4) Alle Assets parallel downloaden (clips + audio + bgm + logo gleichzeitig)
    const clipCount_dl = Math.min(3, clips.length);
    const clipPaths = Array.from({ length: clipCount_dl }, (_, i) => path.join(TMP, `clip_${i}.mp4`));
    const audioCand = audioUrl
      ? path.join(TMP, `voiceover${path.extname(new URL(audioUrl).pathname) || ".mp3"}`)
      : null;
    const bgmCand = backgroundMusicUrl
      ? path.join(TMP, `bgm${path.extname(new URL(backgroundMusicUrl).pathname) || ".mp3"}`)
      : null;
    const logoCand = logo_url
      ? path.join(TMP, `logo${path.extname(new URL(logo_url).pathname) || ".png"}`)
      : null;

    console.log(`[download] fetching ${clipCount_dl} clip(s) + audio/bgm/logo in parallel...`);
    const dlStart = Date.now();

    const [local, audioPath, bgmPath, logoPath] = await Promise.all([
      // Clips — must all succeed
      Promise.all(
        clips.slice(0, 3).map((url, i) => downloadToFile(url, clipPaths[i]).then(() => clipPaths[i]))
      ),
      // Voiceover — must succeed if provided
      audioUrl
        ? downloadToFile(audioUrl, audioCand).then(() => audioCand)
        : Promise.resolve(null),
      // BGM — non-fatal
      tryDownloadOptional(backgroundMusicUrl, bgmCand, "bgm"),
      // Logo — non-fatal
      tryDownloadOptional(logo_url, logoCand, "logo"),
    ]);

    console.log(`[download] all assets ready in ${((Date.now() - dlStart) / 1000).toFixed(1)}s`);

    // 5) Input-Index-Tracking (Reihenfolge: clips → voiceover → bgm → logo)
    let voIdx = -1, bgmIdx = -1, logoIdx = -1;
    const ffInputArgs = [...local.flatMap((p) => ["-i", p])];
    if (audioPath) {
      voIdx = local.length;
      ffInputArgs.push("-i", audioPath);
    }
    if (bgmPath) {
      bgmIdx = local.length + (audioPath ? 1 : 0);
      ffInputArgs.push("-i", bgmPath);
    }
    if (logoPath) {
      logoIdx = local.length + (audioPath ? 1 : 0) + (bgmPath ? 1 : 0);
      ffInputArgs.push("-loop", "1", "-i", logoPath);
    }

    // 6) Clip-Längen bestimmen (parallel)
    const durations = await Promise.all(local.map(probeDurationSeconds));

    const d0 = durations[0] ?? 10.0;
    const d1 = durations[1] ?? 10.0;
    const clipCount = local.length;
    const sumDur = durations.reduce((a, b) => a + (b || 0), 0);
    const estTotal = Math.max(0, sumDur - (clipCount - 1) * fade);
    const padNeeded = Math.max(0, Number(targetDuration) - estTotal);
    const fadeStart = Math.max(0, Number(targetDuration) - Number(fadeOut));

    // 7) Video xfade-Kette → [vout]
    const videoFilter =
      `[0:v]setpts=PTS-STARTPTS[v0];` +
      `[1:v]setpts=PTS-STARTPTS[v1];` +
      (local[2] ? `[2:v]setpts=PTS-STARTPTS[v2];` : "") +
      `[v0][v1]xfade=transition=fade:duration=${fade}:offset=${Math.max(0, d0 - fade).toFixed(3)}[v01];` +
      (local[2]
        ? `[v01][v2]xfade=transition=fade:duration=${fade}:offset=${Math.max(0, d0 + d1 - 2 * fade).toFixed(3)}[vout]`
        : `[v01]copy[vout]`);

    const out = path.join(TMP, "stitched.mp4");

    // 8) Untertitel generieren
    const SUBDIR = "/tmp/subs";
    if (!fs.existsSync(SUBDIR)) fs.mkdirSync(SUBDIR, { recursive: true });
    const subtitleFile = path.join(SUBDIR, "subtitles.srt");
    let haveSubtitleFile = false;

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
        const wordSrt = await buildWordSRTFromText(cleanedText, baseForTiming, subOpts);
        fs.writeFileSync(subtitleFile, wordSrt, "utf8");
        await new Promise((r) => setTimeout(r, 150));
        haveSubtitleFile = fs.existsSync(subtitleFile);
      }
    } else if (audioPath && autoSubtitles && process.env.OPENAI_API_KEY) {
      try {
        console.log("[whisper] transcribing audio...");
        const words = await transcribeWithWhisper(audioPath);
        const whisperSrt = buildSRTFromWords(words, subOpts);
        fs.writeFileSync(subtitleFile, whisperSrt, "utf8");
        await new Promise((r) => setTimeout(r, 150));
        haveSubtitleFile = fs.existsSync(subtitleFile);
        console.log("[whisper] subtitle file written");
      } catch (e) {
        console.error("[whisper] transcription failed, skipping subtitles:", e.message);
      }
    }

    // 9) Subtitle forceStyle + Color Grade
    const forceStyle = buildForceStyle(subtitleStyle);
    const subFilter = haveSubtitleFile
      ? `,subtitles=${escPathForFilter(subtitleFile)}:si=${Number(subtitleDelay).toFixed(2)}:force_style='${forceStyle}':fontsdir=/app/fonts`
      : "";
    const colorGrade = getColorGradeFilter(shop_kategorie);

    // 10) Video-Post-Process: scale → colorgrade → subs → tpad → fade
    //     format=yuv420p is at END of chain (step 13) so subs/overlay
    //     cannot re-introduce 4:4:4 before the encoder.
    const needsOverlay = !!(logoPath || price);
    const stage2Label = needsOverlay ? "vbase" : "vpre";

    const videoPostProcess =
      `[vout]scale=1080:-2,fps=30${colorGrade}${subFilter}` +
      (padNeeded > 0 ? `,tpad=stop_mode=clone:stop_duration=${padNeeded.toFixed(3)}` : "") +
      `,fade=t=out:st=${fadeStart.toFixed(3)}:d=${Number(fadeOut).toFixed(3)}[${stage2Label}]`;

    // 11) Overlay-Kette — final label always [vpre]
    let overlayChain = "";
    if (needsOverlay) {
      let cur = stage2Label;

      if (logoPath) {
        const next = price ? "vwithlogo" : "vpre";
        overlayChain +=
          `;[${logoIdx}:v]scale=150:-1[logo]` +
          `;[${cur}][logo]overlay=W-w-20:20:format=auto[${next}]`;
        cur = next;
      }

      if (price) {
        const escaped = escDrawtext(price);
        overlayChain +=
          `;[${cur}]drawtext=fontfile=/app/fonts/Montserrat-Bold.ttf` +
          `:text='${escaped}'` +
          `:fontcolor=white:fontsize=52` +
          `:x=30:y=H-th-30` +
          `:box=1:boxcolor=black@0.6:boxborderw=10[vpre]`;
      }
    }

    // 12) Audio-Filter — Sidechain Compress wenn VO + BGM
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

    // 13) Kompletter filter_complex — [vpre]format=yuv420p[v] garantiert 4:2:0 in den Encoder
    const fullFilter =
      `${videoFilter};${videoPostProcess}${overlayChain}` +
      `;[vpre]format=yuv420p[v]` +
      `${audioFilterStr}`;

    const args = [
      "-y", "-nostdin", "-loglevel", "error",
      ...ffInputArgs,
      "-filter_complex", fullFilter,
      "-map", "[v]",
      ...(audioMapTarget ? ["-map", audioMapTarget, "-c:a", "aac", "-b:a", "192k"] : ["-an"]),
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
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
        if (logoPath && fs.existsSync(logoPath)) fs.unlinkSync(logoPath);
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
