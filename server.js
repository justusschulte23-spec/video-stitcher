import express from "express";
import { exec, execSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import fetch from "node-fetch";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

const TMP = "/tmp";

const run = (cmd) =>
  new Promise((resolve, reject) => {
    exec(cmd, (err, _so, se) => {
      if (err) {
        console.error(se || err);
        reject(new Error("FFmpeg failed"));
      } else resolve();
    });
  });

const ffprobeDuration = (file) => {
  const out = execSync(
    `ffprobe -v error -show_entries format=duration -of default=nokey=1:noprint_wrappers=1 "${file}"`
  )
    .toString()
    .trim();
  const n = parseFloat(out);
  if (Number.isNaN(n)) throw new Error(`ffprobe failed for ${file}`);
  return n;
};

async function download(url, i) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Download failed ${i}: ${r.status} ${r.statusText}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const p = path.join(TMP, `clip_${i}.mp4`);
  fs.writeFileSync(p, buf);
  return p;
}

app.get("/healthz", (_req, res) => res.send("ok"));

/**
 * POST /stitch
 * { "clips": ["url1","url2","url3"], "fade": 0.5 }
 * - macht Crossfade NUR im Video
 * - fügt am Ende eine stille Audiospur hinzu (AAC), damit das MP4 überall sauber abspielt
 */
app.post("/stitch", async (req, res) => {
  try {
    const { clips, fade } = req.body;
    if (!Array.isArray(clips) || clips.length === 0) {
      return res.status(400).json({ error: "No clips provided" });
    }
    const FADE = Math.max(0.1, Math.min(Number(fade) || 0.5, 3)); // 0.1..3.0 s

    // 1) download
    const files = [];
    for (let i = 0; i < clips.length; i++) files.push(await download(clips[i], i));

    // 2) pairwise xfade (VIDEO ONLY)
    let temp = files[0];
    for (let i = 1; i < files.length; i++) {
      const next = files[i];
      const tempDur = ffprobeDuration(temp);
      const offset = Math.max(FADE * 0.5, tempDur - FADE); // Start Crossfade

      const stepOut = path.join(TMP, `step_${i}.mp4`);
      const cmd = [
        `ffmpeg -y -i "${temp}" -i "${next}"`,
        `-filter_complex`,
        `"[0:v][1:v]xfade=transition=fade:duration=${FADE}:offset=${offset.toFixed(3)}[v]"`,
        `-map "[v]"`,
        `-c:v libx264 -preset veryfast -crf 22 -vf format=yuv420p`,
        `-an`, // keine Audiospur in Zwischensteps
        `"${stepOut}"`
      ].join(" ");
      await run(cmd);
      temp = stepOut;
    }

    // 3) finale stille Audiospur in gleicher Länge anhängen (AAC)
    const finalOut = path.join(TMP, `final_output.mp4`);
    const finalDur = ffprobeDuration(temp);
    const addSilentCmd = [
      // anullsrc (stereo/44.1k) und Video zusammenmuxen, Laufzeit = Video (shortest)
      `ffmpeg -y -i "${temp}" -f lavfi -t ${finalDur.toFixed(3)} -i anullsrc=r=44100:cl=stereo`,
      `-shortest -c:v copy -c:a aac -b:a 128k -movflags +faststart`,
      `"${finalOut}"`
    ].join(" ");
    await run(addSilentCmd);

    // 4) senden
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", 'attachment; filename="stitched.mp4"');
    res.sendFile(finalOut);
  } catch (e) {
    console.error("Server error:", e);
    res.status(500).json({ error: "Server error", details: e.message });
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`Server running on port ${port}`));
