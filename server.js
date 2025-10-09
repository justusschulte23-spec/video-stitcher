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

    // 2) Dauer pro Clip (für xfade-Offsets)
    const durations = [];
    for (const p of local) durations.push(await probeDurationSeconds(p));
    // mind. zwei Werte vorhanden
    const d0 = durations[0];
    const d1 = durations[1];

    // 3) Filter-Graph: Crossfades hintereinander
    // v0 -> v1 (offset d0 - fade), Ergebnis v01
    // v01 -> v2 (offset d0 + d1 - 2*fade), Ergebnis vout
    const inputs = local.map((p, i) => `-i "${p}"`).join(" ");
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

    // 4) FFmpeg: saubere MP4 für alle Player
   const cmd = `
ffmpeg -y ${inputs} \
-filter_complex "${filter};[vout]scale=1080:-2,fps=30,format=yuv420p[v]" \
-map "[v]" -c:v libx264 -profile:v high -level 4.0 -movflags +faststart \
"${out}"
`.replace(/\s+/g, " ");


    const { stderr } = await execa(cmd);
    if (!fs.existsSync(out)) {
      console.error(stderr);
      return res.status(500).json({ error: "FFmpeg failed" });
    }

    // 5) Datei zurückgeben (n8n „Response format = File“ klappt auch)
    const stat = fs.statSync(out);
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Length", stat.size);
    res.setHeader("Content-Disposition", 'attachment; filename="stitched.mp4"');
    fs.createReadStream(out).pipe(res);
  } catch (err) {
    console.error("Server error:", err);
    res.status(500).json({ error: String(err?.message || err) });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
